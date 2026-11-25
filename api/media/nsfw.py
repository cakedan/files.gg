"""NSFW classification (contract milestone-4 §4; milestone-7 §7: the model loads once per process).

The model is Marqo `nsfw-image-detection-384` (a timm ViT-Tiny/16 at 384 px, Apache-2.0),
exported once to ONNX by `tools/export_nsfw_model.py` and checked in under `media/models/`
with its preprocessing JSON. Both files are pinned by SHA-256 here; a file that doesn't
match is refused (`ModelUnavailable`, which keeps the scan pending: a required check).

Split in two, so the model is verified and loaded once per scanner process, not per scan:
- the sandboxed `scan` child decodes the upload and preprocesses the images it keeps for the
  classifier (`write_batch`): one float32 array, saved as `nsfw.npy` in its output directory;
- the scan job (safety/scan.py) runs the process's `classifier()` on that array
  (`classify_batch`), after checking its dtype and shape. It never decodes an image itself.

Only ONNX Runtime, NumPy and Pillow are used at runtime (torch and timm never are). The
preprocessing reproduces timm's evaluation transform from the JSON (never hard-coded):
RGB; resize with its interpolation so the shorter side is `size / crop_pct`; centre-crop to
`size`; scale to [0, 1]; normalise with `mean` and `std`; NCHW float32, batch first. The
score of an image is the softmax probability of the `NSFW` label; a hash's score is the
maximum over its classified images.
"""

import hashlib
import json
import math
import os

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
MODEL_FILE = 'nsfw-marqo-vit-tiny-384.onnx'
CONFIG_FILE = 'nsfw-marqo-vit-tiny-384.json'
# pinned from the export's output (tools/export_nsfw_model.py step 7); a re-export changes all three
MODEL_SHA256 = 'b1b08c0cac3c3c256898dcd53a6a402b6b0a670045a7c4f3defd2b668c1fa875'
CONFIG_SHA256 = 'c196f9f316da819ac3545a20321dd87573e74a8da3b7f57810a4baaa448f2c19'
MODEL_NAME = 'marqo-vit-tiny-384'
INTRA_OP_THREADS = 2
INTER_OP_THREADS = 1
# the child's preprocessed images (media/scanning.py keeps at most 8: NSFW_FRAMES)
BATCH_FILE = 'nsfw.npy'
MAX_BATCH = 8


class ModelUnavailable(Exception):
    """The model or its preprocessing file is missing or doesn't match its pinned hash."""


class BadBatch(Exception):
    """The child's `nsfw.npy` isn't the array it must be (a required check: the scan retries)."""


def model_id():
    """`marqo-vit-tiny-384@<first 8 hex of the ONNX file's SHA-256>`."""
    return '{}@{}'.format(MODEL_NAME, MODEL_SHA256[:8])


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _verified(name, expected):
    path = os.path.join(MODELS_DIR, name)
    try:
        actual = sha256_file(path)
    except OSError as error:
        raise ModelUnavailable('{} is missing: {}'.format(name, error))
    if actual != expected:
        raise ModelUnavailable('{} has SHA-256 {}, expected {}'.format(name, actual, expected))
    return path


def load_config():
    with open(_verified(CONFIG_FILE, CONFIG_SHA256), 'rb') as handle:
        return json.load(handle)


# --- preprocessing (timm's eval transform, with Pillow and NumPy) -------------------------------------

def _resample(name):
    from PIL import Image
    modes = {
        'bicubic': Image.Resampling.BICUBIC, 'bilinear': Image.Resampling.BILINEAR,
        'nearest': Image.Resampling.NEAREST, 'lanczos': Image.Resampling.LANCZOS,
        'box': Image.Resampling.BOX, 'hamming': Image.Resampling.HAMMING,
    }
    if name not in modes:
        raise ModelUnavailable('unsupported interpolation {!r}'.format(name))
    return modes[name]


def _resize_shorter(image, size, resample):
    """torchvision's Resize(int) on a PIL image: the shorter side becomes `size`."""
    width, height = image.size
    short, long = (width, height) if width <= height else (height, width)
    new_short, new_long = size, int(size * long / short)
    new_w, new_h = (new_short, new_long) if width <= height else (new_long, new_short)
    if (new_w, new_h) == (width, height):
        return image
    return image.resize((new_w, new_h), resample)


def _center_crop(image, height, width):
    """torchvision's CenterCrop (images are never smaller than the crop here)."""
    image_w, image_h = image.size
    if image_w < width or image_h < height:
        from PIL import Image
        padded = Image.new('RGB', (max(width, image_w), max(height, image_h)), (0, 0, 0))
        padded.paste(image, ((padded.width - image_w) // 2, (padded.height - image_h) // 2))
        image = padded
        image_w, image_h = image.size
    top = int(round((image_h - height) / 2.0))
    left = int(round((image_w - width) / 2.0))
    return image.crop((left, top, left + width, top + height))


def preprocess(image, config):
    """One PIL image -> a (1, 3, H, W) float32 array, per the preprocessing JSON."""
    import numpy as np
    _, height, width = config['input_size']
    crop_pct = config.get('crop_pct') or 0.875
    crop_mode = config.get('crop_mode') or 'center'
    resample = _resample(config.get('interpolation') or 'bilinear')
    image = image.convert('RGB')
    scale = (math.floor(height / crop_pct), math.floor(width / crop_pct))
    if crop_mode == 'squash':
        image = image.resize((scale[1], scale[0]), resample)
    elif crop_mode == 'center':
        if scale[0] == scale[1]:
            image = _resize_shorter(image, scale[0], resample)
        else:
            # timm's ResizeKeepRatio for a non-square target
            ratio = min(image.width / scale[1], image.height / scale[0])
            image = image.resize((round(image.width / ratio), round(image.height / ratio)), resample)
    else:
        raise ModelUnavailable('unsupported crop_mode {!r}'.format(crop_mode))
    image = _center_crop(image, height, width)
    array = np.asarray(image, dtype=np.float32) / np.float32(255.0)
    mean = np.asarray(config['mean'], dtype=np.float32)
    std = np.asarray(config['std'], dtype=np.float32)
    array = (array - mean) / std
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)


def softmax(logits):
    import numpy as np
    logits = np.asarray(logits, dtype=np.float64)
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)


def write_batch(images, outdir):
    """In the child: the kept PIL images, preprocessed, as one (n, 3, H, W) float32 array in
    `<outdir>/nsfw.npy`. Returns {"count": n} for the child's result."""
    import numpy as np
    config = load_config()
    batch = np.concatenate([preprocess(image, config) for image in images])
    np.save(os.path.join(outdir, BATCH_FILE), batch, allow_pickle=False)
    return {'count': len(images)}


# --- the classifier --------------------------------------------------------------------------------------

class Classifier:
    """ONNX Runtime on CPU, 2 intra-op threads, 1 inter-op thread."""

    def __init__(self):
        import onnxruntime
        self.config = load_config()
        if not isinstance(self.config.get('nsfw_index'), int):
            raise ModelUnavailable('the preprocessing file has no nsfw_index')
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = INTRA_OP_THREADS
        options.inter_op_num_threads = INTER_OP_THREADS
        options.log_severity_level = 3
        self.session = onnxruntime.InferenceSession(
            _verified(MODEL_FILE, MODEL_SHA256), sess_options=options, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name

    def load_batch(self, path, count):
        """The child's array, refused unless it's exactly `count` float32 images of the model's input size.
        `allow_pickle=False`: the file comes from the sandbox, so it's read as plain numbers only."""
        import numpy as np
        if type(count) is not int or not 0 < count <= MAX_BATCH:
            raise BadBatch('{} images in {}, expected 1 to {}'.format(count, BATCH_FILE, MAX_BATCH))
        expected = (count, *self.config['input_size'])
        try:
            batch = np.load(path, allow_pickle=False)
        except (OSError, ValueError) as error:
            raise BadBatch('{} is unreadable: {}'.format(BATCH_FILE, error))
        if batch.dtype != np.float32 or batch.shape != expected:
            raise BadBatch('{} is {} {}, expected float32 {}'.format(BATCH_FILE, batch.dtype, batch.shape, expected))
        return batch

    def classify_batch(self, path, count):
        """{"score": max, "classified": n, "model": id} of the child's array, one image per run."""
        batch = self.load_batch(path, count)
        scores = []
        for index in range(count):
            logits = self.session.run(None, {self.input_name: batch[index:index + 1]})[0]
            scores.append(float(softmax(logits)[0][self.config['nsfw_index']]))
        return {'score': max(scores), 'classified': count, 'model': model_id()}


_classifier = None


def classifier():
    """This process's classifier: the model is verified and loaded on first use, then kept."""
    global _classifier
    if _classifier is None:
        _classifier = Classifier()
    return _classifier
