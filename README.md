# Pageweight

Pageweight is a browser based PDF inspection and image conversion workspace. Files are processed locally in the browser.

## Start the app

```sh
npm install
npm run dev
```

## PDF inspector

Drop in a PDF to view its page count, file size, page preview, and an encoded stream breakdown. Image XObjects and embedded font programs are listed individually. Form XObjects are listed individually; page content and unclassified streams are grouped. Shared resources are counted once, and the remaining bytes are shown as PDF structure.

The stream sizes measure the encoded payload inside PDF streams. They do not assign dictionary, object index, or cross-reference overhead to a particular asset. Inline images and compressed object groups can be included in page content or other streams. Password protected PDFs are not supported.

The asset table can be exported as CSV.

## Image converter

Select or drop multiple PNG, JPEG, and WebP files to convert them to WebP, JPEG, or PNG. WebP and JPEG quality can be adjusted; converted files can be downloaded individually or as a ZIP archive. JPEG output uses a white background for transparent pixels. Canvas conversion removes embedded metadata.

## Build

```sh
npm run build
```
