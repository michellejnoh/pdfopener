# PDFopener ♡

Turn a **PDF** or **Word (.docx)** file into a cute, mobile-friendly e-book, styled like the message screen of an early-2000s flip phone.

**Live site:** https://michellejnoh.github.io/pdfopener/

## What it does
**PDFs** keep their real look (fonts, colours, pictures) but are reflowed for a phone:
- page margins are trimmed and two-column pages are read one column at a time
- each line is cut into its words (as images) and re-wrapped into narrower lines at a comfortable size
- lines are only joined when the page itself wrapped them, so lists, short lines and bullet points keep their real breaks
- pictures and anything unusual are kept whole; tap a piece to zoom in
- Night mode inverts the pages for dark reading

**Word files** become a text e-book: choose *Reading material* or *Vocab list* when you upload
(vocab lists become word cards you can quiz yourself with).

**Highlighting:** tap the marker at the top of the reader, pick yellow, pink or mint and drag over words (in PDFs and Word books). Start a drag on a highlight to erase it.

Everything runs in your browser. Files are never uploaded anywhere. Books and your reading position are saved on your device.

## Built with
Plain HTML, CSS and JavaScript · [PDF.js](https://mozilla.github.io/pdf.js/) · [mammoth.js](https://github.com/mwilliamson/mammoth.js) · fonts: Arial, Silkscreen, DotGothic16, Lora
