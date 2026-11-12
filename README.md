# PDFopener ♡

Turn a **PDF** or **Word (.docx)** file into a cute, mobile-friendly e-book, styled like the message screen of an early-2000s flip phone.

**Live site:** https://michellejnoh.github.io/pdfopener/

## What it does
- Pulls the text out of your file and finds chapters and section headings
- Keeps the pictures and the original text colours
- **Easy layout:** splits long paragraphs into short chunks, turns lists hidden inside sentences into real lists, and puts notes, tips and definitions in their own boxes — without adding or changing any words (switch to *Original* in the menu anytime)
- Fixes small mistakes (common misspellings, a word typed twice, odd spacing); fixed words get a faint dotted underline showing the original
- Removes page numbers and running headers/footers from PDFs
- Lays the book out in pages you can flip (tap the sides, swipe, or use the arrow keys)
- Contents menu, text size, three fonts (Arial / Serif / Pixel) and a Night screen
- Remembers your books and where you stopped reading (saved in your browser)

Everything runs in your browser. Files are never uploaded anywhere.

## Limits
- Scanned PDFs come through as pictures only.
- Multi-column layouts may read in a slightly different order.
- Old `.doc` files need to be re-saved as `.docx` first.

## Built with
Plain HTML, CSS and JavaScript · [PDF.js](https://mozilla.github.io/pdf.js/) · [mammoth.js](https://github.com/mwilliamson/mammoth.js) · fonts: Arial, Silkscreen, DotGothic16, Lora
