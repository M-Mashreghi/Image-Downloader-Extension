# Image Collector (Chrome extension)

Turn it on, browse, and it collects every image you see. Click **Download ZIP** to get them all in one ZIP, named `1.jpg`, `2.png`, `3.webp`, ...

## Install (about 1 minute)
1. Download this repository (green **Code** button → **Download ZIP**, or `git clone`) and unzip it somewhere you'll keep it.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).
5. Pin it: click the puzzle icon in the toolbar, then the pin next to "Image Collector".

## Use
- Click the icon and flip the switch to **ON** (the icon turns blue). The badge shows how many images are collected.
- Browse normally. Scroll down pages so lazy-loaded images load; they get picked up too. It works across all tabs.
- On book readers like HathiTrust, **reload the page after installing or updating** the extension, then turn it on and scroll through the pages you want. Each page is saved as it appears.
- **Auto-scroll**: pick a speed (Slow / Normal / Fast) and click **⬇ Auto-scroll**. The page scrolls down by itself (it also finds a reader's own scroll area, like HathiTrust's) so every image loads and is saved. It stops by itself at the end; click the blue badge or press **Esc** to stop earlier. Use **Slow** on sites that limit how fast you can load pages.
- Click **Download ZIP**. A tab opens, fetches each image, and saves `images_<date>_<time>.zip` to your Downloads.
- **Clear** empties the list to start a new batch. Turning it **OFF** stops collecting but keeps the list.
- **Only from this website**: open the site you want, then tick this box in the popup. It only collects from that site (and its subdomains) and ignores your other tabs. Untick it to collect from everywhere again.
- Optional: tick "Skip tiny images" to drop icons and 1x1 tracking pixels.

## What it catches
`<img>` tags (including `srcset` and lazy `data-src`), `<picture>` sources, CSS background images, video posters, SVG images, embedded `data:` images, `blob:` images that a page builds itself (for example book-reader pages like HathiTrust: they're saved the moment they appear, before the page throws them away), and any image the browser downloads while it's on. The same image URL is only saved once.

## Inside the ZIP
- `1.jpg`, `2.png`, ... in the order they were seen. The extension is detected from the actual file.
- Images that have an `aria-labelledby` label are named after it instead, e.g. `<img aria-labelledby="caption492" ...>` becomes `caption492.jpg`.
- `_sources.txt` lists which original URL and page each number came from.
- `_failed.txt` (only if needed) lists images that couldn't be downloaded, e.g. expired links.

Everything runs locally; no data is sent anywhere.
