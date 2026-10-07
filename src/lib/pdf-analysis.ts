import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from "pdf-lib"

export type AssetCategory = "image" | "font" | "form" | "content" | "other"

export type PdfAsset = {
  id: string
  name: string
  category: AssetCategory
  detail: string
  sizeBytes: number
  pages: number[]
}

export type PdfReport = {
  title: string
  pageCount: number
  pageWidth: number
  pageHeight: number
  streamBytes: number
  structureBytes: number
  assets: PdfAsset[]
  totals: Record<AssetCategory, number>
  imageCount: number
  embeddedFontCount: number
}

type StreamRecord = {
  id: string
  stream: PDFRawStream
  pages: Set<number>
  names: Set<string>
}

const pdfName = (value: string) => PDFName.of(value)

const readName = (dict: PDFDict, key: string) =>
  dict.lookupMaybe(pdfName(key), PDFName)?.decodeText()

const readNumber = (dict: PDFDict, key: string) =>
  dict.lookupMaybe(pdfName(key), PDFNumber)?.asNumber()

const cleanFontName = (name: string) => name.replace(/^[A-Z]{6}\+/, "")

function getFilters(stream: PDFRawStream, resolve: (value?: PDFObject) => PDFObject | undefined) {
  const rawFilter = stream.dict.get(pdfName("Filter"))
  const filter = resolve(rawFilter)

  if (filter instanceof PDFName) return [filter.decodeText()]
  if (filter instanceof PDFArray) {
    return Array.from({ length: filter.size() }, (_, index) => {
      const item = resolve(filter.get(index))
      return item instanceof PDFName ? item.decodeText() : "Unknown filter"
    })
  }

  return []
}

function imageFormat(filters: string[]) {
  if (filters.includes("DCTDecode")) return "JPEG"
  if (filters.includes("JPXDecode")) return "JPEG 2000"
  if (filters.includes("JBIG2Decode")) return "JBIG2"
  if (filters.includes("CCITTFaxDecode")) return "CCITT"
  if (filters.includes("FlateDecode")) return "Flate"
  return filters[0]?.replace("Decode", "") ?? "Unfiltered"
}

function readColorSpace(stream: PDFRawStream, resolve: (value?: PDFObject) => PDFObject | undefined) {
  const colorSpace = resolve(stream.dict.get(pdfName("ColorSpace")))

  if (colorSpace instanceof PDFName) return colorSpace.decodeText()
  if (colorSpace instanceof PDFArray) {
    const family = resolve(colorSpace.get(0))
    if (!(family instanceof PDFName)) return undefined

    const familyName = family.decodeText()
    if (familyName === "Indexed" || familyName === "I") {
      const base = resolve(colorSpace.get(1))
      if (base instanceof PDFName) return `${familyName} ${base.decodeText()}`
    }

    return familyName
  }

  return undefined
}

function imageDetail(
  stream: PDFRawStream,
  filters: string[],
  resolve: (value?: PDFObject) => PDFObject | undefined,
) {
  const width = readNumber(stream.dict, "Width")
  const height = readNumber(stream.dict, "Height")
  const colorSpace = readColorSpace(stream, resolve)
  const bitDepth = readNumber(stream.dict, "BitsPerComponent")
  const parts = [imageFormat(filters)]

  if (width && height) parts.push(`${width} × ${height}`)
  if (colorSpace) parts.push(colorSpace.replace("Device", ""))
  if (bitDepth) parts.push(`${bitDepth}-bit`)

  if (stream.dict.lookupMaybe(pdfName("ImageMask"), PDFBool)?.asBoolean()) parts.push("mask")

  return parts.join(" · ")
}

export async function analyzePdf(data: Uint8Array, fileSize: number): Promise<PdfReport> {
  const document = await PDFDocument.load(data, { updateMetadata: false })
  const context = document.context
  const pageList = document.getPages()
  const streams = new Map<string, StreamRecord>()
  const streamIds = new WeakMap<PDFRawStream, string>()
  const images = new Map<string, StreamRecord>()
  const forms = new Map<string, StreamRecord>()
  const fonts = new Map<string, StreamRecord>()
  const contents = new Map<string, StreamRecord>()
  let directStreamIndex = 0

  const resolve = (value?: PDFObject): PDFObject | undefined =>
    value instanceof PDFRef ? context.lookup(value) : value

  const remember = (stream: PDFRawStream, reference?: PDFObject) => {
    const id = reference instanceof PDFRef
      ? reference.toString()
      : streamIds.get(stream) ?? `direct-stream-${++directStreamIndex}`
    streamIds.set(stream, id)

    const current = streams.get(id) ?? { id, stream, pages: new Set<number>(), names: new Set<string>() }
    streams.set(id, current)
    return current
  }

  for (const [reference, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue

    const record = remember(object, reference)
    const subtype = readName(object.dict, "Subtype")

    if (subtype === "Image") images.set(record.id, record)
    if (subtype === "Form") forms.set(record.id, record)
  }

  const recordFor = (
    target: Map<string, StreamRecord>,
    stream: PDFRawStream,
    reference?: PDFObject,
    pageNumber?: number,
    resourceName?: string,
  ) => {
    const record = remember(stream, reference)
    if (pageNumber) record.pages.add(pageNumber)
    if (resourceName) record.names.add(resourceName)
    target.set(record.id, record)
    return record
  }

  const visitedFonts = new Set<string>()

  const walkFonts = (resources: PDFDict, pageNumber: number) => {
    const fontResources = resources.lookupMaybe(pdfName("Font"), PDFDict)
    if (!fontResources) return

    for (const [resource, rawFont] of fontResources.entries()) {
      const fontObject = resolve(rawFont)
      if (!(fontObject instanceof PDFDict)) continue

      const baseName = cleanFontName(readName(fontObject, "BaseFont") ?? resource.decodeText())
      const fontObjects = [fontObject]
      const descendants = fontObject.lookupMaybe(pdfName("DescendantFonts"), PDFArray)
      if (descendants) {
        for (let index = 0; index < descendants.size(); index += 1) {
          const descendant = resolve(descendants.get(index))
          if (descendant instanceof PDFDict) fontObjects.push(descendant)
        }
      }

      for (const font of fontObjects) {
        const descriptorValue = font.get(pdfName("FontDescriptor"))
        const descriptor = resolve(descriptorValue)
        if (!(descriptor instanceof PDFDict)) continue

        for (const fileKey of ["FontFile", "FontFile2", "FontFile3"]) {
          const rawFontFile = descriptor.get(pdfName(fileKey))
          const fontFile = resolve(rawFontFile)
          if (!(fontFile instanceof PDFRawStream)) continue

          const key = rawFontFile instanceof PDFRef ? rawFontFile.toString() : remember(fontFile).id
          const signature = `${key}:${pageNumber}:${baseName}`
          if (visitedFonts.has(signature)) continue
          visitedFonts.add(signature)
          recordFor(fonts, fontFile, rawFontFile, pageNumber, baseName)
          const record = fonts.get(key)
          if (record) record.names.add(fileKey)
        }
      }
    }
  }

  const walkResources = (resources: PDFDict, pageNumber: number, visitedForms: Set<string>) => {
    const xObjects = resources.lookupMaybe(pdfName("XObject"), PDFDict)

    if (xObjects) {
      for (const [resource, rawObject] of xObjects.entries()) {
        const object = resolve(rawObject)
        if (!(object instanceof PDFRawStream)) continue

        const subtype = readName(object.dict, "Subtype")
        const resourceName = resource.decodeText()

        if (subtype === "Image") {
          recordFor(images, object, rawObject, pageNumber, resourceName)
        } else if (subtype === "Form") {
          const form = recordFor(forms, object, rawObject, pageNumber, resourceName)
          if (visitedForms.has(form.id)) continue
          visitedForms.add(form.id)
          const nestedResources = object.dict.lookupMaybe(pdfName("Resources"), PDFDict)
          if (nestedResources) walkResources(nestedResources, pageNumber, visitedForms)
        }
      }
    }

    walkFonts(resources, pageNumber)
  }

  pageList.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1
    const resources = page.node.Resources()
    if (resources) walkResources(resources, pageNumber, new Set<string>())

    const pageContents = page.node.Contents()
    if (!pageContents) return

    const rawContentItems = pageContents instanceof PDFArray
      ? Array.from({ length: pageContents.size() }, (_, index) => pageContents.get(index))
      : [pageContents]

    for (const rawContent of rawContentItems) {
      const content = resolve(rawContent)
      if (!(content instanceof PDFRawStream)) continue
      recordFor(contents, content, rawContent, pageNumber)
    }
  })

  const classified = new Set([
    ...images.keys(),
    ...forms.keys(),
    ...fonts.keys(),
    ...contents.keys(),
  ])

  const otherStreams = Array.from(streams.values()).filter((stream) => !classified.has(stream.id))
  const aggregateAssets = (
    records: Map<string, StreamRecord>,
    category: AssetCategory,
    name: string,
    detail: string,
  ): PdfAsset[] => {
    const entries = Array.from(records.values())
    if (entries.length === 0) return []

    const pages = Array.from(new Set(entries.flatMap((entry) => Array.from(entry.pages)))).sort((a, b) => a - b)
    return [{
      id: `${category}-group`,
      name,
      category,
      detail,
      sizeBytes: entries.reduce((sum, entry) => sum + entry.stream.getContentsSize(), 0),
      pages,
    }]
  }

  const imageAssets = Array.from(images.values())
    .sort((a, b) => b.stream.getContentsSize() - a.stream.getContentsSize())
    .map((record, index): PdfAsset => {
      const filters = getFilters(record.stream, resolve)
      const name = record.names.size > 0 ? Array.from(record.names).join(", ") : `Image ${index + 1}`
      return {
        id: record.id,
        name: `${name.startsWith("/") ? name : `Image ${index + 1}`} · ${record.id.replace(/ R$/, "")}`,
        category: "image",
        detail: imageDetail(record.stream, filters, resolve),
        sizeBytes: record.stream.getContentsSize(),
        pages: Array.from(record.pages).sort((a, b) => a - b),
      }
    })

  const fontAssets = Array.from(fonts.values())
    .sort((a, b) => b.stream.getContentsSize() - a.stream.getContentsSize())
    .map((record, index): PdfAsset => {
      const labels = Array.from(record.names)
      const fontName = labels.find((label) => !label.startsWith("FontFile")) ?? `Embedded font ${index + 1}`
      const fileKind = labels.find((label) => label.startsWith("FontFile"))
      const subtype = readName(record.stream.dict, "Subtype")
      return {
        id: record.id,
        name: `${fontName} · ${record.id.replace(/ R$/, "")}`,
        category: "font",
        detail: `${subtype ?? fileKind ?? "Embedded font"} program${fileKind ? ` · ${fileKind}` : ""}`,
        sizeBytes: record.stream.getContentsSize(),
        pages: Array.from(record.pages).sort((a, b) => a - b),
      }
    })

  const formAssets = Array.from(forms.values())
    .sort((a, b) => b.stream.getContentsSize() - a.stream.getContentsSize())
    .map((record, index): PdfAsset => ({
      id: record.id,
      name: `${Array.from(record.names)[0] ?? `Form ${index + 1}`} · ${record.id.replace(/ R$/, "")}`,
      category: "form",
      detail: "Reusable vector/form stream",
      sizeBytes: record.stream.getContentsSize(),
      pages: Array.from(record.pages).sort((a, b) => a - b),
    }))

  const contentAssets = aggregateAssets(
    contents,
    "content",
    `${contents.size} page content stream${contents.size === 1 ? "" : "s"}`,
    "Text, vector paths, and drawing instructions",
  )
  const otherAssets = aggregateAssets(
    new Map(otherStreams.map((stream) => [stream.id, stream])),
    "other",
    `${otherStreams.length} other stream${otherStreams.length === 1 ? "" : "s"}`,
    "Metadata, profiles, attachments, or unclassified streams",
  )

  const assets = [...imageAssets, ...fontAssets, ...formAssets, ...contentAssets, ...otherAssets]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
  const totals: Record<AssetCategory, number> = {
    image: imageAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    font: fontAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    form: formAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    content: contentAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    other: otherAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
  }
  const streamBytes = Array.from(streams.values()).reduce((sum, item) => sum + item.stream.getContentsSize(), 0)
  const firstPage = pageList[0]

  return {
    title: document.getTitle() ?? "",
    pageCount: pageList.length,
    pageWidth: firstPage?.getWidth() ?? 0,
    pageHeight: firstPage?.getHeight() ?? 0,
    streamBytes,
    structureBytes: Math.max(0, fileSize - streamBytes),
    assets,
    totals,
    imageCount: imageAssets.length,
    embeddedFontCount: fontAssets.length,
  }
}
