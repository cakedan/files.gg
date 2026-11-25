"""One-time export of the NSFW model to ONNX (contract milestone-4 §4.1). A build step, not part
of any image: run it in a throwaway environment from tools/export-requirements.txt (the command
is at the top of that file), from the api/ directory:

    python -m tools.export_nsfw_model [--out media/models]

Steps:
1. download `model.safetensors` and `config.json` of Marqo/nsfw-image-detection-384 at the
   pinned commit, and check both SHA-256s against the values below;
2. build the model with timm from those files, in eval() mode;
3. read timm's resolve_data_config, and find the output index of the `NSFW` label;
4. export with torch.onnx.export: opset 17, input `pixel_values` (NCHW float32, dynamic
   batch), output `logits`;
5. verify: onnx.checker passes, and on the fixture images ONNX Runtime's NSFW probability
   (after the scan child's own Pillow and NumPy preprocessing, media/nsfw.py) is within 1e-3
   of PyTorch's (after timm's own transform);
6. write the preprocessing JSON (input_size, interpolation, mean, std, crop_pct, crop_mode,
   nsfw_index, plus provenance);
7. print the SHA-256 of both files, to pin in media/nsfw.py.

A re-export may not reproduce the same bytes: the checked-in files are the artefacts of record.
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile

REPOSITORY = 'Marqo/nsfw-image-detection-384'
# a full revision hash, never `main` (checked 2026-11-25: the repository's only commit since 2024-11-27)
REVISION = '0c26ec22111b83f106d72a55f611ec35962bcb65'
SOURCE_SHA256 = {
    'model.safetensors': '6bf2e0f64a1d20169736c2836e3a787b12379fdc08ba87f7d94a7a3d58eeefce',
    'config.json': 'ae848d1dca0aeccd38f2ebb4b1bb47219cdc7f34e3ddc50c8d6430abe74d79b4',
}
OPSET = 17
TOLERANCE = 1e-3
API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(API_DIR, 'media', 'models')
ONNX_NAME = 'nsfw-marqo-vit-tiny-384.onnx'
JSON_NAME = 'nsfw-marqo-vit-tiny-384.json'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download(workdir):
    """Step 1."""
    from huggingface_hub import hf_hub_download
    paths = {}
    for name, expected in SOURCE_SHA256.items():
        path = hf_hub_download(REPOSITORY, name, revision=REVISION, cache_dir=workdir)
        actual = sha256(path)
        if actual != expected:
            raise SystemExit('{} has SHA-256 {}, expected {}: refusing to export'.format(name, actual, expected))
        paths[name] = path
    return paths


def build(paths):
    """Steps 2 and 3: the model, its data config and the NSFW index."""
    import timm
    from safetensors.torch import load_file
    with open(paths['config.json'], 'rb') as handle:
        config = json.load(handle)
    labels = config.get('label_names') or []
    if 'NSFW' not in labels:
        raise SystemExit('the model config has no NSFW label: {!r}'.format(labels))
    model = timm.create_model(config['architecture'], pretrained=False, num_classes=config['num_classes'],
                              global_pool=config.get('global_pool', 'token'),
                              pretrained_cfg=config['pretrained_cfg'])
    model.load_state_dict(load_file(paths['model.safetensors']), strict=True)
    model.eval()
    data_config = timm.data.resolve_data_config({}, model=model)
    return model, config, data_config, labels.index('NSFW')


def export(model, data_config, path):
    """Step 4."""
    import torch
    dummy = torch.zeros((1, *data_config['input_size']), dtype=torch.float32)
    with torch.no_grad():
        torch.onnx.export(model, (dummy,), path, opset_version=OPSET, input_names=['pixel_values'],
                          output_names=['logits'],
                          dynamic_axes={'pixel_values': {0: 'batch'}, 'logits': {0: 'batch'}},
                          do_constant_folding=True, dynamo=False)


def fixture_images():
    """The stand-in fixtures (§14.5) plus a few generated images of other shapes and content."""
    import numpy as np
    from PIL import Image, ImageDraw
    sys.path.insert(0, API_DIR)
    from tests.fixtures.standin import make_fixtures
    images = {name: Image.open(io.BytesIO(data)).convert('RGB') for name, data in make_fixtures.images().items()}
    rng = np.random.default_rng(20261125)
    images['noise-640x360.png'] = Image.fromarray(rng.integers(0, 256, (360, 640, 3), dtype=np.uint8))
    gradient = np.zeros((900, 300, 3), dtype=np.uint8)
    gradient[..., 0] = np.linspace(0, 255, 900, dtype=np.uint8)[:, None]
    gradient[..., 2] = np.linspace(255, 0, 300, dtype=np.uint8)[None, :]
    images['gradient-300x900.png'] = Image.fromarray(gradient)
    shapes = Image.new('RGB', (1024, 768), (230, 220, 200))
    draw = ImageDraw.Draw(shapes)
    for i in range(12):
        draw.ellipse([40 + i * 70, 60 + (i % 4) * 150, 160 + i * 70, 200 + (i % 4) * 150],
                     fill=(200 - i * 12, 80 + i * 10, 40 + i * 15))
    images['shapes-1024x768.png'] = shapes
    images['tiny-50x40.png'] = Image.new('RGB', (50, 40), (12, 200, 90))
    return images


def verify(model, data_config, nsfw_index, onnx_path, preprocessing):
    """Step 5."""
    import numpy as np
    import onnx
    import onnxruntime
    import timm
    import torch
    sys.path.insert(0, API_DIR)
    from media import nsfw as child
    onnx.checker.check_model(onnx.load(onnx_path), full_check=True)
    session = onnxruntime.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
    transform = timm.data.create_transform(**data_config, is_training=False)
    results = []
    for name, image in fixture_images().items():
        with torch.no_grad():
            reference = torch.softmax(model(transform(image).unsqueeze(0)), dim=-1)[0, nsfw_index].item()
        logits = session.run(None, {'pixel_values': child.preprocess(image, preprocessing)})[0]
        ours = float(child.softmax(logits)[0][nsfw_index])
        difference = abs(ours - reference)
        results.append((name, reference, ours, difference))
        print('  {:24s} torch {:.6f}  onnx {:.6f}  |diff| {:.2e}'.format(name, reference, ours, difference))
    batch = np.concatenate([child.preprocess(image, preprocessing) for image in list(fixture_images().values())[:2]])
    if session.run(None, {'pixel_values': batch})[0].shape[0] != 2:
        raise SystemExit('the dynamic batch axis does not work')
    worst = max(r[3] for r in results)
    if worst > TOLERANCE:
        raise SystemExit('ONNX and PyTorch disagree by {:.2e} (> {})'.format(worst, TOLERANCE))
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m tools.export_nsfw_model')
    parser.add_argument('--out', default=DEFAULT_OUT)
    options = parser.parse_args(argv)
    import onnx
    import timm
    import torch

    workdir = tempfile.mkdtemp(prefix='nsfw-export-')
    try:
        paths = download(workdir)
        model, config, data_config, nsfw_index = build(paths)
        preprocessing = {
            'input_size': list(data_config['input_size']),
            'interpolation': data_config['interpolation'],
            'mean': [float(x) for x in data_config['mean']],
            'std': [float(x) for x in data_config['std']],
            'crop_pct': float(data_config['crop_pct']),
            'crop_mode': data_config.get('crop_mode', 'center'),
            'nsfw_index': nsfw_index,
            'labels': config['label_names'],
            'provenance': {
                'repository': REPOSITORY,
                'revision': REVISION,
                'source_sha256': SOURCE_SHA256,
                'architecture': config['architecture'],
                'torch': torch.__version__,
                'timm': timm.__version__,
                'onnx': onnx.__version__,
                'opset': OPSET,
                'input': 'pixel_values',
                'output': 'logits',
            },
        }
        onnx_tmp = os.path.join(workdir, ONNX_NAME)
        export(model, data_config, onnx_tmp)
        print('verifying against PyTorch:')
        verify(model, data_config, nsfw_index, onnx_tmp, preprocessing)
        os.makedirs(options.out, exist_ok=True)
        onnx_path = os.path.join(options.out, ONNX_NAME)
        json_path = os.path.join(options.out, JSON_NAME)
        shutil.copyfile(onnx_tmp, onnx_path)
        with open(json_path, 'w') as handle:
            json.dump(preprocessing, handle, indent=2, sort_keys=True)
            handle.write('\n')
        print('wrote {} ({} bytes)'.format(onnx_path, os.path.getsize(onnx_path)))
        print("MODEL_SHA256 = '{}'".format(sha256(onnx_path)))
        print("CONFIG_SHA256 = '{}'".format(sha256(json_path)))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
