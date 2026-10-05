# Video Downloader

Chrome extension (Manifest V3) that detects videos on a web page and downloads them for offline viewing.

## Features

- Detects direct videos (`mp4`, `webm`…) and HLS (`m3u8`) / DASH (`mpd`) streams
- Quality picker for streams, AES-128 encrypted HLS supported
- Clean file names from the page title (duplicates and site name removed)
- Downloads keep running when the popup is closed
- Compact light UI, inline settings (default format, download subfolder)

## Install (developer mode)

1. Clone this repo
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the project folder

## Usage

Open a page with a video, click the extension icon, pick a quality, then click the download button.

## Disclaimer

Only download content you have the right to save. You are responsible for respecting copyright and the terms of the sites you use.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, modify and share for any non-commercial purpose. Commercial use is not permitted.
