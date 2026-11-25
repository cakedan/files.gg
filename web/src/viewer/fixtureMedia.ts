/**
 * Dev-only media made in the browser for the milestone 3 fixtures (imported only by
 * fixtures.ts, which main.tsx loads behind `import.meta.env.DEV`): text files, a
 * peaks.json and a short playable WebM clip. They're `blob:` URLs, so nothing is added
 * to web/fixtures/ and nothing is downloaded.
 */

const blobUrl = (parts: BlobPart[], type: string) => URL.createObjectURL(new Blob(parts, { type }));

export const textUrl = (text: string) => blobUrl([text], 'text/plain;charset=utf-8');

/** `{ version: 1, length: 1000, peaks }`: a beat-like envelope, rounded to 3 decimals. */
export function peaksUrl(): string {
  const peaks = Array.from({ length: 1000 }, (_, i) => {
    const beat = Math.exp(-((i % 50) / 12));
    const swell = 0.35 + 0.3 * Math.sin((i / 1000) * Math.PI * 3) ** 2;
    const noise = 0.08 * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
    return Math.round(Math.min(1, swell * (0.45 + 0.55 * beat) + noise) * 1000) / 1000;
  });
  return blobUrl([JSON.stringify({ version: 1, length: peaks.length, peaks })], 'application/json');
}

let clip: Promise<string | null> | null = null;

/**
 * Records a short WebM of an animated canvas with MediaRecorder: a real, playable,
 * seekable-enough video for the player fixture. Null where MediaRecorder is missing.
 * (MediaRecorder WebM has no duration header, so the player relies on the payload's.)
 */
export function recordClip(seconds = 3): Promise<string | null> {
  clip ??= new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
      (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
    );
    if (!ctx || !type || typeof canvas.captureStream !== 'function') {
      resolve(null);
      return;
    }
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const started = performance.now();
    const draw = () => {
      const t = (performance.now() - started) / 1000;
      const hue = 145 + Math.sin(t * 2) * 30;
      ctx.fillStyle = `hsl(${hue} 70% 18%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#3deb7e';
      ctx.beginPath();
      ctx.arc(320 + Math.cos(t * 2.2) * 200, 180 + Math.sin(t * 3.1) * 110, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f2f3f5';
      ctx.font = 'bold 42px system-ui, sans-serif';
      ctx.fillText(`files.gg ${t.toFixed(1)} s`, 24, 64);
    };
    const timer = window.setInterval(draw, 1000 / 30);
    draw();
    recorder.onstop = () => {
      window.clearInterval(timer);
      resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
    };
    recorder.start(250);
    window.setTimeout(() => recorder.stop(), seconds * 1000);
  });
  return clip;
}

export const PYTHON_SAMPLE = `"""Resize every image in a folder, keeping the aspect ratio."""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

SUPPORTED = {".png", ".jpg", ".jpeg", ".webp"}


@dataclass(frozen=True)
class Job:
    source: Path
    target: Path
    max_side: int = 1280

    def run(self) -> tuple[int, int]:
        with Image.open(self.source) as image:
            image.thumbnail((self.max_side, self.max_side))
            image.save(self.target, optimize=True)
            return image.size


def find_jobs(folder: Path, out: Path, max_side: int) -> list[Job]:
    jobs = []
    for path in sorted(folder.iterdir()):
        if path.suffix.lower() not in SUPPORTED:
            continue
        jobs.append(Job(path, out / path.name, max_side))
    return jobs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--out", type=Path, default=Path("resized"))
    parser.add_argument("--max-side", type=int, default=1280)
    args = parser.parse_args(argv)

    args.out.mkdir(exist_ok=True)
    jobs = find_jobs(args.folder, args.out, args.max_side)
    if not jobs:
        print("No images found", file=sys.stderr)
        return 1

    for job in jobs:
        width, height = job.run()
        print(f"{job.source.name}: {width}x{height}")  # one line per image
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

export const TYPESCRIPT_SAMPLE = `import { useEffect, useState } from 'react';

/** Debounces a value: it updates only after \`delay\` ms without changes. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export interface SearchResult {
  id: string;
  title: string;
  score: number;
  tags?: readonly string[];
}

const ENDPOINT = 'https://example.com/search';

export async function search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query.trim());
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(\`Search failed: \${response.status}\`);
  const body = (await response.json()) as { results: SearchResult[] };
  return body.results.filter((r) => r.score > 0.2).sort((a, b) => b.score - a.score);
}

export class LruCache<K, V> {
  #map = new Map<K, V>();
  constructor(private readonly limit = 100) {}

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value as K);
  }
}
`;

export const RUST_SAMPLE = `use std::collections::HashMap;
use std::io::{self, BufRead};

/// Counts words read from stdin and prints the ten most common.
fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut counts: HashMap<String, usize> = HashMap::new();

    for line in stdin.lock().lines() {
        for word in line?.split_whitespace() {
            let word = word
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase();
            if !word.is_empty() {
                *counts.entry(word).or_insert(0) += 1;
            }
        }
    }

    let mut sorted: Vec<_> = counts.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    for (word, count) in sorted.iter().take(10) {
        println!("{count:>6}  {word}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn trims_punctuation() {
        assert_eq!("hello,".trim_matches(|c: char| !c.is_alphanumeric()), "hello");
    }
}
`;

export const JSON_SAMPLE = `{
  "name": "weekend-trip",
  "version": 3,
  "private": true,
  "days": [
    { "date": "2026-11-21", "stops": ["Station", "Coast path", "Lighthouse"], "km": 14.2 },
    { "date": "2026-11-22", "stops": ["Market", "Hill fort"], "km": 9.8 }
  ],
  "budget": { "currency": "EUR", "total": 240, "spent": 187.5 },
  "notes": null,
  "done": false
}
`;

export const MARKDOWN_SAMPLE = `# Release notes

## 3.0

- **Albums:** group files, reorder them, and share one link.
- Video and audio get a new player with speed control and keyboard shortcuts.
- Code files are highlighted, with links to single lines like \`#L12\`.

> Old links keep working.

\`\`\`sh
npm run build
\`\`\`

See [the changelog](https://example.com/changelog) for everything else.
`;

export const PLAIN_SAMPLE = `Packing list
============

- passport
- charger (the long cable)
- rain jacket
- two books, one of them short

Leave the spare key with the neighbour on Friday.
\tIndented with a tab, to check tab width.
A very long line that keeps going so the wrap toggle has something to do: lorem ipsum is not used here, just plain words repeated until the line is clearly wider than the card on a phone and on most laptops too.
`;

/** Under 1 MiB but over 20,000 lines: only the line limit can catch it (after fetching). */
export function manyLines(count = 25_000): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}
