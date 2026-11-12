# PDFopener ♡

Turn a **PDF** or **Word (.docx)** file into a cute, mobile-friendly e-book, styled like the message screen of an early-2000s flip phone.

**Live site:** https://michellejnoh.github.io/pdfopener/

## What it does
- Pulls the text out of your file and finds chapters and section headings
- Removes page numbers and running headers/footers from PDFs
- Lays the book out in pages you can flip (tap the sides, swipe, or use the arrow keys)
- Contents menu, text size, three fonts (Round / Serif / Pixel) and a Night screen
- Remembers your books and where you stopped reading (saved in your browser)

Everything runs in your browser. Files are never uploaded anywhere.

## Limits
- Scanned PDFs (photos of pages) have no text inside, so they can't be converted.
- Images and complex layouts are left out to keep things readable.
- Old `.doc` files need to be re-saved as `.docx` first.

## Built with
Plain HTML, CSS and JavaScript · [PDF.js](https://mozilla.github.io/pdf.js/) · [mammoth.js](https://github.com/mwilliamson/mammoth.js) · fonts: Silkscreen, DotGothic16, Nunito, Lora
