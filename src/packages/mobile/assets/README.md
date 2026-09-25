The app icon uses CoCalc's existing artwork from `../../assets/cocalc-icon.svg`.
Regenerate the opaque 1024×1024 PNG from the mobile package directory with ImageMagick:

```sh
magick -density 1536 -background white ../assets/cocalc-icon.svg -resize 800x800 -gravity center -extent 1024x1024 -alpha off assets/icon.png
```

Changing the home-screen icon requires rebuilding and installing the native app.

`preview-plot.png` is a bundled, offline sine-curve fixture. Regenerate it with
`python3 scripts/generate-preview-plot.py` (requires matplotlib and numpy).
