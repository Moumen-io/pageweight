import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib"
import { encodeCanvasAsJpeg, type JpegContentProfile, type JpegEncoder } from "@/lib/jpeg-encoding"

const name = (value: string) => PDFName.of(value)
const MAX_OPTIMIZABLE_PIXELS = 16_000_000

export type PdfImageAsset = {
  id: string
  width: number
  height: number
  format: string
  sizeBytes: number
  previewUrl: string | null
  canOptimize: boolean
  reason: string | null
  hasSoftMask: boolean
}

export type OptimizedPdfImage = {
  id: string
  blob: Blob
  originalBytes: number
  width: number
  height: number
  previewUrl: string | null
}

type ImageRecord = {
  ref: PDFRef
  stream: PDFRawStream
}

type ImageColorSpace = {
  name: "DeviceRGB" | "DeviceGray" | "ICCBased"
  channels: 1 | 3
  iccProfile: Uint8Array | null
}

function resolve(context: PDFDocument["context"], value?: PDFObject): PDFObject | undefined {
  return value instanceof PDFRef ? context.lookup(value) : value
}

function filtersFor(stream: PDFRawStream, context: PDFDocument["context"]) {
  const filter = resolve(context, stream.dict.get(name("Filter")))
  if (filter instanceof PDFName) return [filter.decodeText()]
  if (filter instanceof PDFArray) {
    return Array.from({ length: filter.size() }, (_, index) => {
      const item = resolve(context, filter.get(index))
      return item instanceof PDFName ? item.decodeText() : "Unknown"
    })
  }
  return []
}

function colorSpaceFor(stream: PDFRawStream, context: PDFDocument["context"]): ImageColorSpace | null {
  const colorSpace = resolve(context, stream.dict.get(name("ColorSpace")))
  if (colorSpace instanceof PDFName) {
    const colorSpaceName = colorSpace.decodeText()
    if (colorSpaceName === "DeviceRGB") return { name: colorSpaceName, channels: 3, iccProfile: null }
    if (colorSpaceName === "DeviceGray") return { name: colorSpaceName, channels: 1, iccProfile: null }
    return null
  }

  if (!(colorSpace instanceof PDFArray)) return null
  const family = resolve(context, colorSpace.get(0))
  if (!(family instanceof PDFName) || family.decodeText() !== "ICCBased") return null

  const profile = resolve(context, colorSpace.get(1))
  if (!(profile instanceof PDFRawStream)) return null
  const channels = numberFor(profile, "N")
  if (channels !== 1 && channels !== 3) return null

  try {
    const iccProfile = decodePDFRawStream(profile).decode()
    const colorSignature = channels === 1 ? "GRAY" : "RGB "
    if (iccProfile.length < 128
      || String.fromCharCode(...iccProfile.subarray(16, 20)) !== colorSignature
      || String.fromCharCode(...iccProfile.subarray(36, 40)) !== "acsp") return null
    return { name: "ICCBased", channels, iccProfile }
  } catch {
    return null
  }
}

function numberFor(stream: PDFRawStream, key: string) {
  return stream.dict.lookupMaybe(name(key), PDFNumber)?.asNumber() ?? null
}

function imageDimensions(stream: PDFRawStream) {
  return {
    width: numberFor(stream, "Width") ?? 0,
    height: numberFor(stream, "Height") ?? 0,
  }
}

function simpleDecodeParms(stream: PDFRawStream, context: PDFDocument["context"]) {
  const raw = resolve(context, stream.dict.get(name("DecodeParms")))
  if (!raw || raw === PDFNull) return { predictor: 1, columns: null, colors: null }

  const params = raw instanceof PDFArray ? resolve(context, raw.get(0)) : raw
  if (!params || params === PDFNull) return { predictor: 1, columns: null, colors: null }
  if (!(params instanceof PDFDict)) return null

  const predictor = params.lookupMaybe(name("Predictor"), PDFNumber)?.asNumber() ?? 1
  const columns = params.lookupMaybe(name("Columns"), PDFNumber)?.asNumber() ?? null
  const colors = params.lookupMaybe(name("Colors"), PDFNumber)?.asNumber() ?? null
  return { predictor, columns, colors }
}

function unfilterSamples(bytes: Uint8Array, width: number, height: number, channels: number, predictor: number) {
  const rowBytes = width * channels
  const output = new Uint8Array(rowBytes * height)
  const bytesPerPixel = channels

  if (predictor === 1) {
    if (bytes.length !== output.length) throw new Error("Unexpected image sample length")
    return bytes
  }

  if (predictor === 2) {
    if (bytes.length !== output.length) throw new Error("Unexpected TIFF predictor length")
    output.set(bytes)
    for (let row = 0; row < height; row += 1) {
      const rowStart = row * rowBytes
      for (let index = bytesPerPixel; index < rowBytes; index += 1) {
        output[rowStart + index] = (output[rowStart + index] + output[rowStart + index - bytesPerPixel]) & 0xff
      }
    }
    return output
  }

  if (predictor < 10 || predictor > 15) throw new Error("Unsupported image predictor")
  const hasRowTag = predictor === 15
  const encodedRowBytes = rowBytes + (hasRowTag ? 1 : 0)
  if (bytes.length !== encodedRowBytes * height) throw new Error("Unexpected PNG predictor length")

  let previousRow = new Uint8Array(rowBytes)
  for (let row = 0; row < height; row += 1) {
    const inputStart = row * encodedRowBytes
    const rowFilter = hasRowTag ? bytes[inputStart] : predictor - 10
    const inputOffset = inputStart + (hasRowTag ? 1 : 0)
    const rowStart = row * rowBytes

    for (let column = 0; column < rowBytes; column += 1) {
      const raw = bytes[inputOffset + column]
      const left = column >= bytesPerPixel ? output[rowStart + column - bytesPerPixel] : 0
      const above = previousRow[column]
      const upperLeft = column >= bytesPerPixel ? previousRow[column - bytesPerPixel] : 0
      let prediction = 0

      if (rowFilter === 1) prediction = left
      else if (rowFilter === 2) prediction = above
      else if (rowFilter === 3) prediction = Math.floor((left + above) / 2)
      else if (rowFilter === 4) {
        const estimate = left + above - upperLeft
        const leftDistance = Math.abs(estimate - left)
        const aboveDistance = Math.abs(estimate - above)
        const upperLeftDistance = Math.abs(estimate - upperLeft)
        prediction = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
          ? left
          : aboveDistance <= upperLeftDistance ? above : upperLeft
      } else if (rowFilter !== 0) throw new Error("Invalid PNG predictor row")

      output[rowStart + column] = (raw + prediction) & 0xff
    }
    previousRow = output.subarray(rowStart, rowStart + rowBytes)
  }
  return output
}

function samplesFor(record: ImageRecord, context: PDFDocument["context"], channels: number) {
  const filterNames = filtersFor(record.stream, context)
  if (filterNames.length > 1 || (filterNames.length === 1 && filterNames[0] !== "FlateDecode")) {
    throw new Error("Unsupported image encoding")
  }

  const decodeParms = simpleDecodeParms(record.stream, context)
  if (!decodeParms) throw new Error("Unsupported image parameters")
  if (decodeParms.colors !== null && decodeParms.colors !== channels) throw new Error("Unsupported image colors")

  const { width, height } = imageDimensions(record.stream)
  if (decodeParms.columns !== null && decodeParms.columns !== width) throw new Error("Unsupported image columns")
  const decoded = filterNames.length === 0
    ? record.stream.contents
    : decodePDFRawStream(record.stream).decode()
  return unfilterSamples(decoded, width, height, channels, decodeParms.predictor)
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolveBlob, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolveBlob(blob)
      else reject(new Error("This browser could not prepare an image preview."))
    }, type, quality)
  })
}

function joinBytes(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const jpegIccIdentifier = new TextEncoder().encode("ICC_PROFILE\0")

function stripJpegIccProfiles(jpeg: Uint8Array) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Invalid JPEG image data")

  const parts = [jpeg.subarray(0, 2)]
  let offset = 2
  while (offset < jpeg.length) {
    const markerStart = offset
    if (jpeg[offset] !== 0xff) {
      parts.push(jpeg.subarray(offset))
      break
    }

    while (offset < jpeg.length && jpeg[offset] === 0xff) offset += 1
    if (offset >= jpeg.length) throw new Error("Invalid JPEG marker")
    const marker = jpeg[offset]
    offset += 1

    if (marker === 0xda) {
      parts.push(jpeg.subarray(markerStart))
      break
    }

    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(jpeg.subarray(markerStart, offset))
      continue
    }

    if (offset + 2 > jpeg.length) throw new Error("Invalid JPEG segment")
    const segmentLength = (jpeg[offset] << 8) | jpeg[offset + 1]
    const segmentEnd = offset + segmentLength
    if (segmentLength < 2 || segmentEnd > jpeg.length) throw new Error("Invalid JPEG segment length")

    const payloadStart = offset + 2
    const hasIccIdentifier = marker === 0xe2
      && segmentEnd - payloadStart >= jpegIccIdentifier.length + 2
      && jpegIccIdentifier.every((byte, index) => jpeg[payloadStart + index] === byte)
    if (!hasIccIdentifier) parts.push(jpeg.subarray(markerStart, segmentEnd))
    offset = segmentEnd
  }

  return joinBytes(parts)
}

function embedJpegIccProfile(jpeg: Uint8Array, profile: Uint8Array) {
  const strippedJpeg = stripJpegIccProfiles(jpeg)
  const maximumChunkSize = 65_519
  const chunkCount = Math.ceil(profile.length / maximumChunkSize)
  if (chunkCount < 1 || chunkCount > 255) throw new Error("ICC profile is too large for a JPEG image")

  const profileChunks: Uint8Array[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * maximumChunkSize
    const profilePart = profile.subarray(start, Math.min(start + maximumChunkSize, profile.length))
    const segment = new Uint8Array(18 + profilePart.length)
    segment[0] = 0xff
    segment[1] = 0xe2
    const segmentLength = segment.length - 2
    segment[2] = segmentLength >>> 8
    segment[3] = segmentLength & 0xff
    segment.set(jpegIccIdentifier, 4)
    segment[16] = index + 1
    segment[17] = chunkCount
    segment.set(profilePart, 18)
    profileChunks.push(segment)
  }

  return joinBytes([
    strippedJpeg.subarray(0, 2),
    ...profileChunks,
    strippedJpeg.subarray(2),
  ])
}

const pngCrcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function pngCrc(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function createPngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(new TextEncoder().encode(type), 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, pngCrc(chunk.subarray(4, 8 + data.length)))
  return chunk
}

async function embedPngIccProfile(pngBlob: Blob, profile: Uint8Array) {
  if (typeof CompressionStream === "undefined") throw new Error("ICC image previews are not supported in this browser")
  const profileBuffer = profile.slice().buffer as ArrayBuffer
  const profileStream = new Blob([profileBuffer]).stream().pipeThrough(new CompressionStream("deflate"))
  const compressedProfile = new Uint8Array(await new Response(profileStream).arrayBuffer())
  const profileName = new TextEncoder().encode("PDF-ICC")
  const profileChunkData = new Uint8Array(profileName.length + 2 + compressedProfile.length)
  profileChunkData.set(profileName)
  profileChunkData[profileName.length] = 0
  profileChunkData[profileName.length + 1] = 0
  profileChunkData.set(compressedProfile, profileName.length + 2)
  const iccChunk = createPngChunk("iCCP", profileChunkData)

  const png = new Uint8Array(await pngBlob.arrayBuffer())
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((byte, index) => png[index] === byte)) throw new Error("Invalid PNG preview")

  const parts = [png.subarray(0, 8)]
  let offset = 8
  let inserted = false
  while (offset + 12 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0)
    const end = offset + length + 12
    if (end > png.length) throw new Error("Invalid PNG chunk")

    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type !== "iCCP" && type !== "sRGB" && type !== "gAMA" && type !== "cHRM") {
      parts.push(png.subarray(offset, end))
    }
    if (type === "IHDR") {
      parts.push(iccChunk)
      inserted = true
    }
    offset = end
  }

  if (!inserted || offset !== png.length) throw new Error("Could not attach the PDF color profile to the image preview")
  const pngBuffer = joinBytes(parts).buffer as ArrayBuffer
  return new Blob([pngBuffer], { type: "image/png" })
}

async function rasterPreview(
  record: ImageRecord,
  context: PDFDocument["context"],
  colorSpace: ImageColorSpace,
) {
  const { width, height } = imageDimensions(record.stream)
  const channels = colorSpace.channels
  const samples = samplesFor(record, context, channels)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const canvasContext = canvas.getContext("2d")
  if (!canvasContext) throw new Error("Canvas is unavailable")

  const rgba = canvasContext.createImageData(width, height)
  for (let pixel = 0, sample = 0; pixel < width * height; pixel += 1) {
    const target = pixel * 4
    if (channels === 1) {
      const gray = samples[sample++]
      rgba.data[target] = gray
      rgba.data[target + 1] = gray
      rgba.data[target + 2] = gray
    } else {
      rgba.data[target] = samples[sample++]
      rgba.data[target + 1] = samples[sample++]
      rgba.data[target + 2] = samples[sample++]
    }
    rgba.data[target + 3] = 255
  }
  canvasContext.putImageData(rgba, 0, 0)
  return canvasToBlob(canvas, "image/png")
}

function assetReason(
  record: ImageRecord,
  context: PDFDocument["context"],
  width: number,
  height: number,
  maskIds: Set<string>,
) {
  const stream = record.stream
  const filters = filtersFor(stream, context)
  const colorSpace = colorSpaceFor(stream, context)

  if (maskIds.has(record.ref.toString())) return "Transparency masks are kept lossless."
  if (stream.dict.lookupMaybe(name("ImageMask"), PDFBool)?.asBoolean()) return "Monochrome masks are kept lossless."
  if (stream.dict.has(name("Mask"))) return "Color-key transparency cannot be recompressed safely."
  if (stream.dict.has(name("Decode"))) return "Custom color decoding is preserved as-is."
  if (width < 1 || height < 1) return "Image dimensions are missing."
  if (width * height > MAX_OPTIMIZABLE_PIXELS) return "This image is too large to process in this browser."
  if (numberFor(stream, "BitsPerComponent") !== 8) return "Only 8-bit images can be recompressed."
  if (!colorSpace) return "This image uses an unsupported color space or profile."
  if (filters.length > 1 || (filters.length === 1 && filters[0] !== "DCTDecode" && filters[0] !== "FlateDecode")) {
    return "This image encoding is preserved as-is."
  }

  const decodeParms = simpleDecodeParms(stream, context)
  if (!decodeParms) return "This image encoding is preserved as-is."
  if (filters[0] !== "DCTDecode" && ![1, 2, 10, 11, 12, 13, 14, 15].includes(decodeParms.predictor)) {
    return "This image encoding is preserved as-is."
  }
  if (decodeParms.colors !== null && decodeParms.colors !== colorSpace.channels) {
    return "This image encoding is preserved as-is."
  }
  if (decodeParms.columns !== null && decodeParms.columns !== width) return "This image encoding is preserved as-is."
  return null
}

export async function loadPdfImageAssets(data: Uint8Array): Promise<PdfImageAsset[]> {
  const pdf = await PDFDocument.load(data, { updateMetadata: false })
  const context = pdf.context
  const images: ImageRecord[] = []
  const maskIds = new Set<string>()

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue
    if (object.dict.lookupMaybe(name("Subtype"), PDFName)?.decodeText() !== "Image") continue
    const record = { ref, stream: object }
    images.push(record)
    const softMask = object.dict.get(name("SMask"))
    if (softMask instanceof PDFRef) maskIds.add(softMask.toString())
  }

  const assets: PdfImageAsset[] = []
  for (const record of images) {
    const { width, height } = imageDimensions(record.stream)
    const filters = filtersFor(record.stream, context)
    const format = filters.includes("DCTDecode") ? "JPEG"
      : filters.includes("FlateDecode") ? "Flate"
        : filters[0]?.replace("Decode", "") ?? "Raw"
    const reason = assetReason(record, context, width, height, maskIds)
    let previewUrl: string | null = null

    try {
      if (filters.length === 1 && filters[0] === "DCTDecode") {
        const colorSpace = colorSpaceFor(record.stream, context)
        const jpegBytes = colorSpace?.iccProfile
          ? embedJpegIccProfile(record.stream.contents, colorSpace.iccProfile)
          : record.stream.contents
        const bytes = jpegBytes.slice().buffer as ArrayBuffer
        previewUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }))
      } else if (width > 0 && height > 0 && width * height <= MAX_OPTIMIZABLE_PIXELS) {
        const colorSpace = colorSpaceFor(record.stream, context)
        if (colorSpace) {
          let blob = await rasterPreview(record, context, colorSpace)
          if (colorSpace.iccProfile) blob = await embedPngIccProfile(blob, colorSpace.iccProfile)
          previewUrl = URL.createObjectURL(blob)
        }
      }
    } catch {
      previewUrl = null
    }

    assets.push({
      id: record.ref.toString(),
      width,
      height,
      format,
      sizeBytes: record.stream.getContentsSize(),
      previewUrl,
      canOptimize: reason === null && previewUrl !== null,
      reason: reason ?? (previewUrl === null ? "A preview could not be prepared for this image." : null),
      hasSoftMask: record.stream.dict.has(name("SMask")),
    })
  }
  return assets
}

export async function compressPdfImage(
  asset: PdfImageAsset,
  quality: number,
  encoder: JpegEncoder,
  contentProfile: JpegContentProfile,
  maxPhotoDimension: number | null,
): Promise<OptimizedPdfImage> {
  if (!asset.canOptimize || !asset.previewUrl) throw new Error("This image cannot be recompressed.")
  const response = await fetch(asset.previewUrl)
  const bitmap = await createImageBitmap(await response.blob())

  try {
    const maximumDimension = contentProfile === "text" || asset.hasSoftMask || maxPhotoDimension === null
      ? Math.max(bitmap.width, bitmap.height)
      : maxPhotoDimension
    const scale = Math.min(1, maximumDimension / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas is unavailable in this browser.")
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await encodeCanvasAsJpeg(canvas, quality / 100, encoder, contentProfile)
    return {
      id: asset.id,
      blob,
      originalBytes: asset.sizeBytes,
      width: canvas.width,
      height: canvas.height,
      previewUrl: URL.createObjectURL(blob),
    }
  } finally {
    bitmap.close()
  }
}

export async function applyPdfImageOptimizations(file: File, images: OptimizedPdfImage[]) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const context = pdf.context
  const streams = new Map<string, { ref: PDFRef; stream: PDFRawStream }>()

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.lookupMaybe(name("Subtype"), PDFName)?.decodeText() === "Image") {
      streams.set(ref.toString(), { ref, stream: object })
    }
  }

  for (const image of images) {
    const source = streams.get(image.id)
    if (!source || image.blob.size >= image.originalBytes) continue

    const dictionary = source.stream.dict.clone(context)
    dictionary.set(name("Filter"), name("DCTDecode"))
    dictionary.set(name("ColorSpace"), name("DeviceRGB"))
    dictionary.set(name("BitsPerComponent"), PDFNumber.of(8))
    dictionary.set(name("Width"), PDFNumber.of(image.width))
    dictionary.set(name("Height"), PDFNumber.of(image.height))
    dictionary.delete(name("DecodeParms"))
    dictionary.delete(name("Decode"))
    const imageBytes = new Uint8Array(await image.blob.arrayBuffer())
    context.assign(source.ref, PDFRawStream.of(dictionary, imageBytes))
  }

  const optimizedBytes = await pdf.save()
  const outputName = `${file.name.replace(/(?:-optimized)?\.pdf$/i, "")}-optimized.pdf`
  return new File([optimizedBytes.slice().buffer as ArrayBuffer], outputName, { type: "application/pdf" })
}
