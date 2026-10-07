import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  FileImage,
  FileText,
  Image as ImageIcon,
  Layers2,
  LockKeyhole,
  ScanSearch,
  Upload,
  X,
} from "lucide-react"
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist"
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import type { AssetCategory, PdfAsset, PdfReport } from "@/lib/pdf-analysis"
import type { OptimizedPdfImage, PdfImageAsset } from "@/lib/pdf-optimization"
import type { JpegContentProfile, JpegEncoder } from "@/lib/jpeg-encoding"
import { convertImage, type ConvertedImage, type OutputFormat } from "@/lib/image-conversion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "cn"

type ToolMode = "inspect" | "convert"
type AssetFilter = "all" | AssetCategory
const formatOptions: { value: OutputFormat; label: string; detail: string }[] = [
  { value: "image/avif", label: "AVIF", detail: "Compact photos" },
  { value: "image/webp", label: "WebP", detail: "Best balance" },
  { value: "image/jpeg", label: "JPEG", detail: "Smaller photos" },
  { value: "image/png", label: "PNG", detail: "Lossless" },
]

const jpegEncoderOptions: { value: JpegEncoder; label: string; detail: string }[] = [
  { value: "mozjpeg", label: "MozJPEG", detail: "Smaller files" },
  { value: "browser", label: "Browser", detail: "Native encoder" },
]

const photoDimensionOptions: { value: string; label: string }[] = [
  { value: "2200", label: "2,200 px max" },
  { value: "1600", label: "1,600 px max" },
  { value: "original", label: "Original size" },
]

const filterOptions: { value: AssetFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "font", label: "Fonts" },
  { value: "form", label: "Forms" },
  { value: "content", label: "Page content" },
  { value: "other", label: "Other" },
]

const categoryInfo: Record<AssetCategory | "structure", { label: string; className: string }> = {
  image: { label: "Image", className: "asset-color-image" },
  font: { label: "Font", className: "asset-color-font" },
  form: { label: "Form", className: "asset-color-form" },
  content: { label: "Page content", className: "asset-color-content" },
  other: { label: "Other streams", className: "asset-color-other" },
  structure: { label: "PDF structure", className: "asset-color-structure" },
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`
}

function formatPageList(pages: number[]) {
  if (pages.length === 0) return "Not mapped"
  if (pages.length <= 3) return pages.join(", ")
  return `${pages.slice(0, 3).join(", ")} +${pages.length - 3}`
}

function csvCell(value: string | number) {
  const text = String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : "The file could not be read."
  if (/encrypt|password/i.test(message)) return "This PDF is password protected. Unlock it and try again."
  if (/invalid pdf|header|format/i.test(message)) return "This file does not look like a valid PDF."
  return message
}

function assetIcon(category: AssetCategory) {
  if (category === "image") return <ImageIcon aria-hidden="true" />
  if (category === "font") return <span aria-hidden="true" className="font-glyph">Aa</span>
  if (category === "form") return <Layers2 aria-hidden="true" />
  if (category === "content") return <FileText aria-hidden="true" />
  return <ArrowLeftRight aria-hidden="true" />
}

const DEFAULT_JPEG_QUALITY = 74
const DEFAULT_JPEG_ENCODER: JpegEncoder = "mozjpeg"
const DEFAULT_PHOTO_MAX_DIMENSION = 2200

function AssetTable({
  assets,
  file,
  fileSize,
  images,
  imageLoadError,
  onReplaceDocument,
}: {
  assets: PdfAsset[]
  file: File
  fileSize: number
  images: PdfImageAsset[]
  imageLoadError: string | null
  onReplaceDocument: (file: File) => void
}) {
  const [filter, setFilter] = useState<AssetFilter>("all")
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [quality, setQuality] = useState(DEFAULT_JPEG_QUALITY)
  const [draftQuality, setDraftQuality] = useState(DEFAULT_JPEG_QUALITY)
  const [jpegEncoder, setJpegEncoder] = useState<JpegEncoder>(DEFAULT_JPEG_ENCODER)
  const [photoMaxDimension, setPhotoMaxDimension] = useState<number | null>(DEFAULT_PHOTO_MAX_DIMENSION)
  const [textSensitiveIds, setTextSensitiveIds] = useState<Set<string>>(() => new Set())
  const [optimizedImages, setOptimizedImages] = useState<OptimizedPdfImage[]>([])
  const [isOptimizing, setIsOptimizing] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [comparisonPosition, setComparisonPosition] = useState(50)
  const optimizationRunRef = useRef(0)
  const ownedPreviewUrlsRef = useRef(new Set<string>())

  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images])
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const optimizedById = useMemo(
    () => new Map(optimizedImages.map((image) => [image.id, image])),
    [optimizedImages],
  )
  const filteredAssets = useMemo(
    () => filter === "all" ? assets : assets.filter((asset) => asset.category === filter),
    [assets, filter],
  )
  const optimizableImages = useMemo(
    () => images.filter((image) => image.canOptimize && image.previewUrl),
    [images],
  )
  const selectedOptimizedImages = optimizedImages.filter(
    (image) => selectedIds.has(image.id) && image.blob.size < image.originalBytes,
  )
  const selectedSavings = selectedOptimizedImages.reduce(
    (sum, image) => sum + image.originalBytes - image.blob.size,
    0,
  )
  const allOptimizableSelected = optimizableImages.length > 0
    && optimizableImages.every((image) => selectedIds.has(image.id))
  const estimatedPdfSize = Math.max(0, fileSize - selectedSavings)
  const downloadHint = selectedSavings > 0
    ? `${formatBytes(selectedSavings)} smaller · about ${formatBytes(estimatedPdfSize)} total`
    : isOptimizing
      ? "Updating the selected image estimates"
      : selectedIds.size === 0
        ? optimizableImages.length === 0 ? "No supported images to include" : "Select images to include in the PDF"
        : "No reduction available for this selection at the current quality"

  const clearOptimizedPreviews = useCallback(() => {
    for (const url of ownedPreviewUrlsRef.current) URL.revokeObjectURL(url)
    ownedPreviewUrlsRef.current.clear()
  }, [])

  const optimizeImages = useCallback(async (
    nextQuality: number,
    nextEncoder: JpegEncoder,
    nextTextSensitiveIds: Set<string>,
    nextPhotoMaxDimension: number | null,
  ) => {
    const runId = optimizationRunRef.current + 1
    optimizationRunRef.current = runId
    clearOptimizedPreviews()
    setOptimizedImages([])
    setQuality(nextQuality)
    setIsOptimizing(optimizableImages.length > 0)
    setProgress({ completed: 0, total: optimizableImages.length })
    setError(null)
    setPreviewId(null)

    if (optimizableImages.length === 0) {
      setIsOptimizing(false)
      return
    }

    let failedCount = 0
    try {
      const { compressPdfImage } = await import("@/lib/pdf-optimization")
      for (const [index, image] of optimizableImages.entries()) {
        if (optimizationRunRef.current !== runId) return
        try {
          const contentProfile: JpegContentProfile = nextTextSensitiveIds.has(image.id) ? "text" : "photo"
          const result = await compressPdfImage(
            image,
            nextQuality,
            nextEncoder,
            contentProfile,
            nextPhotoMaxDimension,
          )
          if (optimizationRunRef.current !== runId) {
            if (result.previewUrl) URL.revokeObjectURL(result.previewUrl)
            return
          }
          if (result.previewUrl) ownedPreviewUrlsRef.current.add(result.previewUrl)
          setOptimizedImages((previous) => [...previous.filter((item) => item.id !== result.id), result])
        } catch {
          failedCount += 1
        }
        if (optimizationRunRef.current === runId) {
          setProgress({ completed: index + 1, total: optimizableImages.length })
        }
      }
      if (failedCount > 0 && optimizationRunRef.current === runId) {
        setError(`${failedCount} image${failedCount === 1 ? "" : "s"} could not be prepared. Those streams will stay unchanged.`)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The images could not be optimized in this browser."
      if (optimizationRunRef.current === runId) setError(message)
    } finally {
      if (optimizationRunRef.current === runId) setIsOptimizing(false)
    }
  }, [clearOptimizedPreviews, optimizableImages])

  useEffect(() => {
    setExpandedIds(new Set())
    setSelectedIds(new Set(optimizableImages.map((image) => image.id)))
    setDraftQuality(DEFAULT_JPEG_QUALITY)
    setJpegEncoder(DEFAULT_JPEG_ENCODER)
    setPhotoMaxDimension(DEFAULT_PHOTO_MAX_DIMENSION)
    setTextSensitiveIds(new Set())
    void optimizeImages(
      DEFAULT_JPEG_QUALITY,
      DEFAULT_JPEG_ENCODER,
      new Set(),
      DEFAULT_PHOTO_MAX_DIMENSION,
    )
    return () => {
      optimizationRunRef.current += 1
    }
  }, [images, optimizableImages, optimizeImages])

  useEffect(() => () => clearOptimizedPreviews(), [clearOptimizedPreviews])

  const toggleExpanded = (id: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const selectAllOptimizable = () => {
    setSelectedIds(allOptimizableSelected
      ? new Set()
      : new Set(optimizableImages.map((image) => image.id)))
  }

  const setTextSensitive = (id: string, enabled: boolean) => {
    const next = new Set(textSensitiveIds)
    if (enabled) next.add(id)
    else next.delete(id)
    setTextSensitiveIds(next)
    void optimizeImages(quality, jpegEncoder, next, photoMaxDimension)
  }

  const downloadOptimizedPdf = async () => {
    if (selectedOptimizedImages.length === 0 || isApplying || isOptimizing) return
    setIsApplying(true)
    setError(null)
    try {
      const { applyPdfImageOptimizations } = await import("@/lib/pdf-optimization")
      const optimizedFile = await applyPdfImageOptimizations(file, selectedOptimizedImages)
      if (optimizedFile.size >= file.size) {
        throw new Error("The PDF did not shrink overall. Try a lower JPEG quality or select more images.")
      }
      downloadBlob(optimizedFile, optimizedFile.name)
      onReplaceDocument(optimizedFile)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The optimized PDF could not be created."
      setError(message)
    } finally {
      setIsApplying(false)
    }
  }

  const previewAsset = previewId ? assetById.get(previewId) : undefined
  const previewImage = previewId ? imageById.get(previewId) : undefined
  const previewResult = previewId ? optimizedById.get(previewId) : undefined

  return (
    <section className="asset-table-panel" aria-labelledby="asset-breakdown-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ENCODED STREAMS</p>
          <h2 id="asset-breakdown-title">Asset breakdown</h2>
        </div>
        <span className="asset-count">{assets.length} entries</span>
      </div>

      <ToggleGroup
        aria-label="Filter assets by type"
        className="asset-filters"
        multiple={false}
        onValueChange={(values) => {
          if (values[0]) setFilter(values[0] as AssetFilter)
        }}
        value={[filter]}
        variant="outline"
        size="sm"
      >
        {filterOptions.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <ScrollArea className="asset-table-scroll">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="select-column"><span className="sr-only">Include in optimized PDF</span></TableHead>
              <TableHead>Embedded item</TableHead>
              <TableHead className="page-column">Pages</TableHead>
              <TableHead className="size-column">Encoded size</TableHead>
              <TableHead className="optimized-column">Optimized</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAssets.map((asset) => {
              const image = asset.category === "image" ? imageById.get(asset.id) : undefined
              const result = optimizedById.get(asset.id)
              const expanded = expandedIds.has(asset.id)
              const selected = selectedIds.has(asset.id)
              const textSensitive = textSensitiveIds.has(asset.id)
              const detailsId = `asset-details-${asset.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
              const sizeDelta = result && result.originalBytes > 0
                ? Math.round(((result.blob.size - result.originalBytes) / result.originalBytes) * 100)
                : null

              return (
                <Fragment key={asset.id}>
                  <TableRow className={cn("asset-row", expanded && "is-expanded")}>
                    <TableCell className="select-column">
                      {asset.category === "image" && image?.canOptimize && (
                        <Checkbox
                          aria-label={`Include ${asset.name} in optimized PDF`}
                          checked={selected}
                          disabled={isApplying}
                          onCheckedChange={(checked) => toggleSelected(asset.id, checked === true)}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="asset-name-cell">
                        {asset.category === "image" && (
                          <Button
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${asset.name}`}
                            className="asset-expand-trigger"
                            onClick={() => toggleExpanded(asset.id)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <ChevronDown data-icon="inline-start" />
                          </Button>
                        )}
                        <span className={cn("asset-type-mark", categoryInfo[asset.category].className)}>
                          {assetIcon(asset.category)}
                        </span>
                        <span className="asset-copy">
                          <span className="asset-name">{asset.name}</span>
                          <span className="asset-detail">{asset.detail}</span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="page-column page-value">{formatPageList(asset.pages)}</TableCell>
                    <TableCell className="size-column">
                      <span className="size-value">{formatBytes(asset.sizeBytes)}</span>
                      <span className="size-share">{((asset.sizeBytes / fileSize) * 100).toFixed(1)}%</span>
                    </TableCell>
                    <TableCell className="optimized-column">
                      {asset.category !== "image" ? (
                        <span className="size-muted">—</span>
                      ) : result ? (
                        <span className="optimized-size-value">
                          <strong>{formatBytes(result.blob.size)}</strong>
                          {sizeDelta !== null && (
                            <small className={sizeDelta <= 0 ? "is-smaller" : "is-larger"}>
                              {sizeDelta <= 0 ? `${Math.abs(sizeDelta)}% smaller` : `${sizeDelta}% larger`}
                            </small>
                          )}
                        </span>
                      ) : image?.canOptimize && isOptimizing ? (
                        <span className="size-muted">Preparing…</span>
                      ) : image?.reason ? (
                        <span className="size-muted" title={image.reason}>Kept as-is</span>
                      ) : imageLoadError ? (
                        <span className="size-muted" title={imageLoadError}>Unavailable</span>
                      ) : (
                        <span className="size-muted">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {expanded && asset.category === "image" && (
                    <TableRow className="asset-expanded-row" id={detailsId}>
                      <TableCell className="asset-expanded-cell" colSpan={5}>
                        <div className="asset-expanded-content">
                          <div className="asset-expanded-previews">
                            <div className="asset-expanded-preview">
                              <span>Encoded</span>
                              {image?.previewUrl
                                ? <img src={image.previewUrl} alt={`Encoded preview of ${asset.name}`} />
                                : <span className="asset-preview-unavailable"><FileImage aria-hidden="true" /></span>}
                            </div>
                            <div className="asset-expanded-preview">
                              <span>Optimized</span>
                              {result?.previewUrl
                                ? <img src={result.previewUrl} alt={`Optimized preview of ${asset.name}`} />
                                : <span className="asset-preview-unavailable">{isOptimizing ? "Preparing…" : "Not available"}</span>}
                            </div>
                          </div>
                          <div className="asset-expanded-copy">
                            <p>{image ? `${image.width} × ${image.height} px · ${image.format} source` : imageLoadError ?? "Image data is unavailable for optimization."}</p>
                            <div className="asset-expanded-sizes">
                              <span><small>Encoded</small><strong>{formatBytes(asset.sizeBytes)}</strong></span>
                              <span><small>Optimized at {quality}%</small><strong>{result ? formatBytes(result.blob.size) : isOptimizing && image?.canOptimize ? "Preparing…" : "—"}</strong></span>
                            </div>
                            {image?.canOptimize && (
                              <div className="asset-treatment-control">
                                <span className="asset-treatment-label">Image treatment</span>
                                <ToggleGroup
                                  aria-label={`Compression profile for ${asset.name}`}
                                  className="image-profile-options"
                                  disabled={isOptimizing || isApplying}
                                  multiple={false}
                                  onValueChange={(values) => {
                                    if (values[0]) setTextSensitive(asset.id, values[0] === "text")
                                  }}
                                  value={[textSensitive ? "text" : "photo"]}
                                  variant="outline"
                                  size="sm"
                                >
                                  <ToggleGroupItem value="photo">Photo</ToggleGroupItem>
                                  <ToggleGroupItem value="text">Text & detail</ToggleGroupItem>
                                </ToggleGroup>
                                <p>
                                  {textSensitive
                                    ? jpegEncoder === "mozjpeg"
                                      ? "Keeps source resolution and uses 4:4:4 color detail with MozJPEG."
                                      : "Keeps source resolution for text and fine detail."
                                    : image.hasSoftMask
                                      ? "Keeps source resolution to preserve the original transparency mask."
                                      : `Downsamples to ${photoMaxDimension ? `${photoMaxDimension}px max` : "original size"} and prioritizes smaller photos.`}
                                </p>
                              </div>
                            )}
                            {image?.reason && <p className="asset-optimization-reason">{image.reason}</p>}
                            {image?.hasSoftMask && <p className="asset-optimization-reason">Transparency is kept in its original soft mask.</p>}
                            <div className="asset-expanded-actions">
                              <span>{image?.canOptimize ? `${jpegEncoder === "mozjpeg" ? "MozJPEG" : "Browser JPEG"} recompression runs locally in your browser.` : "This stream is left unchanged."}</span>
                              <Button
                                disabled={!image?.previewUrl || !result?.previewUrl}
                                onClick={() => {
                                  setComparisonPosition(50)
                                  setPreviewId(asset.id)
                                }}
                                size="sm"
                                variant="outline"
                              >
                                <Eye data-icon="inline-start" />
                                Preview
                              </Button>
                            </div>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
            {filteredAssets.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="empty-table-cell">
                  No stream entries match this filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>

      {images.length > 0 && (
        <div className="asset-optimization-controls">
          <div className="asset-quality-controls">
            <div className="quality-heading">
              <Label htmlFor="pdf-image-quality">JPEG quality</Label>
              <span>{draftQuality}%</span>
            </div>
            <Slider
              aria-label="PDF image JPEG quality"
              disabled={isOptimizing || isApplying}
              id="pdf-image-quality"
              max={90}
              min={10}
              onValueChange={(value) => {
                const nextValue = Array.isArray(value) ? value[0] : value
                if (typeof nextValue === "number") setDraftQuality(nextValue)
              }}
              step={1}
              value={[draftQuality]}
            />
            <div className="jpeg-encoder-control">
              <Label>JPEG encoder</Label>
              <ToggleGroup
                aria-label="PDF JPEG encoder"
                className="jpeg-encoder-options"
                disabled={isOptimizing || isApplying || optimizableImages.length === 0}
                multiple={false}
                onValueChange={(values) => {
                  const nextEncoder = values[0] as JpegEncoder | undefined
                  if (!nextEncoder) return
                  setJpegEncoder(nextEncoder)
                  void optimizeImages(quality, nextEncoder, textSensitiveIds, photoMaxDimension)
                }}
                value={[jpegEncoder]}
                variant="outline"
                size="sm"
              >
                {jpegEncoderOptions.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value} className="format-option">
                    <span>{option.label}</span>
                    <small>{option.detail}</small>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="photo-resolution-control">
              <Label>Photo resolution</Label>
              <ToggleGroup
                aria-label="Maximum resolution for photo images"
                className="photo-resolution-options"
                disabled={isOptimizing || isApplying || optimizableImages.length === 0}
                multiple={false}
                onValueChange={(values) => {
                  if (!values[0]) return
                  const nextDimension = values[0] === "original" ? null : Number(values[0])
                  setPhotoMaxDimension(nextDimension)
                  void optimizeImages(quality, jpegEncoder, textSensitiveIds, nextDimension)
                }}
                value={[photoMaxDimension?.toString() ?? "original"]}
                variant="outline"
                size="sm"
              >
                {photoDimensionOptions.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p>Text & detail images keep their original dimensions. Photo images can be downsampled to reduce the PDF further.</p>
            </div>
            <Button
              disabled={draftQuality === quality || isOptimizing || isApplying || optimizableImages.length === 0}
              onClick={() => void optimizeImages(draftQuality, jpegEncoder, textSensitiveIds, photoMaxDimension)}
              size="sm"
              variant="outline"
            >
              {isOptimizing ? <Spinner data-icon="inline-start" /> : <ArrowRight data-icon="inline-start" />}
              {isOptimizing ? "Optimizing images" : `Confirm ${draftQuality}%`}
            </Button>
            <p>Images are prepared automatically at {quality}% quality. Confirm a new value to re-optimize all supported images. Quality can go down to 10%.</p>
          </div>

          <div className="asset-optimization-actions">
            <div className="asset-selection-actions">
              <span><strong>{selectedIds.size}</strong> selected for the PDF</span>
              <Button
                disabled={optimizableImages.length === 0 || isApplying}
                onClick={selectAllOptimizable}
                size="sm"
                variant="ghost"
              >
                {allOptimizableSelected ? "Clear selection" : "Select all"}
              </Button>
            </div>
            <div className="asset-download-actions">
              <span>{downloadHint}</span>
              <Button
                disabled={selectedOptimizedImages.length === 0 || isOptimizing || isApplying}
                onClick={() => void downloadOptimizedPdf()}
                size="lg"
              >
                {isApplying ? <Spinner data-icon="inline-start" /> : <ArrowDownToLine data-icon="inline-start" />}
                {isApplying ? "Building PDF" : "Download optimized PDF"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {isOptimizing && progress.total > 0 && (
        <div className="conversion-progress optimization-progress">
          <div className="progress-copy"><span>Optimizing supported images in the background</span><span>{progress.completed} / {progress.total}</span></div>
          <Progress value={(progress.completed / progress.total) * 100} />
        </div>
      )}
      {error && (
        <Alert variant="destructive" className="optimization-error">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Image optimization needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <p className="table-footnote">Sizes are encoded stream bytes. Shared PDF resources are counted once. Unsupported image encodings remain unchanged.</p>

      <Dialog open={previewId !== null} onOpenChange={(open) => { if (!open) setPreviewId(null) }}>
        <DialogContent className="image-compare-dialog">
          <DialogHeader>
            <DialogTitle>{previewAsset?.name ?? "Image comparison"}</DialogTitle>
            <DialogDescription>
              Compare the encoded source with its JPEG recompression at {quality}% quality.
            </DialogDescription>
          </DialogHeader>
          {previewImage?.previewUrl && previewResult?.previewUrl && (
            <>
              <div className="image-compare-stage">
                <img className="image-compare-optimized" src={previewResult.previewUrl} alt="Optimized image" />
                <div
                  className="image-compare-original-clip"
                  style={{ clipPath: `inset(0 ${100 - comparisonPosition}% 0 0)` }}
                >
                  <img src={previewImage.previewUrl} alt="Original encoded image" />
                </div>
                <div className="image-compare-divider" style={{ left: `${comparisonPosition}%` }} aria-hidden="true" />
                <span className="image-compare-label image-compare-label-before">Original</span>
                <span className="image-compare-label image-compare-label-after">Optimized</span>
              </div>
              <div className="image-compare-control">
                <div className="quality-heading">
                  <Label htmlFor="image-compare-position">Before / after split</Label>
                  <span>{comparisonPosition}%</span>
                </div>
                <Slider
                  aria-label="Original and optimized image split position"
                  id="image-compare-position"
                  max={100}
                  min={0}
                  onValueChange={(value) => {
                    const nextValue = Array.isArray(value) ? value[0] : value
                    if (typeof nextValue === "number") setComparisonPosition(nextValue)
                  }}
                  step={1}
                  value={[comparisonPosition]}
                />
              </div>
              <div className="image-compare-sizes">
                <span><small>Encoded</small><strong>{formatBytes(previewImage.sizeBytes)}</strong></span>
                <span><small>Optimized</small><strong>{formatBytes(previewResult.blob.size)}</strong></span>
                <span><small>At quality</small><strong>{quality}%</strong></span>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function PdfPreview({
  document,
  pageNumber,
  pageCount,
  pageWidth,
  pageHeight,
  error,
  onPageChange,
}: {
  document: PDFDocumentProxy | null
  pageNumber: number
  pageCount: number
  pageWidth: number
  pageHeight: number
  error: string | null
  onPageChange: (pageNumber: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [renderError, setRenderError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let cancelRender: (() => void) | undefined

    if (!document || !canvasRef.current) return

    const canvas = canvasRef.current
    setRenderError(null)

    void document.getPage(pageNumber).then(async (page) => {
      if (cancelled) return
      const baseViewport = page.getViewport({ scale: 1 })
      const devicePixelRatio = window.devicePixelRatio || 1
      const fitScale = Math.min(1.2, 520 / baseViewport.width)
      const viewport = page.getViewport({ scale: fitScale * devicePixelRatio })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${Math.ceil(viewport.width / devicePixelRatio)}px`
      canvas.style.height = `${Math.ceil(viewport.height / devicePixelRatio)}px`
      const renderTask = page.render({ canvas, viewport })
      cancelRender = () => renderTask.cancel()
      await renderTask.promise
    }).catch((renderCause: unknown) => {
      if (cancelled) return
      const message = renderCause instanceof Error ? renderCause.message : "The page preview could not be rendered."
      setRenderError(message)
    })

    return () => {
      cancelled = true
      cancelRender?.()
    }
  }, [document, pageNumber])

  return (
    <Card className="preview-card">
      <CardHeader className="preview-card-header">
        <div>
          <p className="eyebrow">PAGE PREVIEW</p>
          <CardTitle>Document page</CardTitle>
        </div>
        {document && pageCount > 1 && (
          <div className="page-navigation">
            <Button
              aria-label="Previous page"
              disabled={pageNumber <= 1}
              onClick={() => onPageChange(pageNumber - 1)}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            <span>{pageNumber} / {pageCount}</span>
            <Button
              aria-label="Next page"
              disabled={pageNumber >= pageCount}
              onClick={() => onPageChange(pageNumber + 1)}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="preview-card-content">
        {document && !renderError && !error ? (
          <div className="pdf-canvas-stage">
            <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
          </div>
        ) : (
          <div className="preview-unavailable">
            <FileText aria-hidden="true" />
            <span>{error ?? renderError ?? "Preview unavailable"}</span>
          </div>
        )}
        {!renderError && !error && document && (
          <CardDescription className="page-caption">
            Page {pageNumber} · {Math.round(pageWidth)} × {Math.round(pageHeight)} pt
          </CardDescription>
        )}
      </CardContent>
    </Card>
  )
}

function PdfWorkspace({
  file,
  report,
  previewDocument,
  previewError,
  imageAssets,
  imageLoadError,
  onReplaceDocument,
  isAnalyzing,
  error,
  onPickFile,
  onDropFile,
  onExport,
}: {
  file: File | null
  report: PdfReport | null
  previewDocument: PDFDocumentProxy | null
  previewError: string | null
  imageAssets: PdfImageAsset[]
  imageLoadError: string | null
  onReplaceDocument: (file: File) => void
  isAnalyzing: boolean
  error: string | null
  onPickFile: () => void
  onDropFile: (file: File) => void
  onExport: () => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [pageNumber, setPageNumber] = useState(1)
  useEffect(() => {
    setPageNumber(1)
  }, [file])

  if (!file || !report) {
    return (
      <div className="upload-layout">
        <div
          className={cn("pdf-dropzone", dragOver && "is-dragging", isAnalyzing && "is-processing")}
          onDragEnter={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
            const droppedFile = Array.from(event.dataTransfer.files).find((candidate) => candidate.name.toLowerCase().endsWith(".pdf"))
            if (droppedFile) onDropFile(droppedFile)
          }}
        >
          <Empty className="pdf-empty-state">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="upload-icon-wrap">
                {isAnalyzing ? <Spinner /> : <ScanSearch />}
              </EmptyMedia>
              <EmptyTitle>{isAnalyzing ? "Reading document streams…" : "Drop a PDF to inspect its contents"}</EmptyTitle>
              <EmptyDescription>
                {isAnalyzing
                  ? "The file is being analyzed locally in your browser."
                  : "See the encoded size of images, embedded fonts, page content, and other PDF streams."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button disabled={isAnalyzing} onClick={onPickFile} size="lg">
                {isAnalyzing ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
                {isAnalyzing ? "Analyzing PDF" : "Choose a PDF"}
              </Button>
              <p className="upload-limit">PDF files · Files stay on this device</p>
            </EmptyContent>
          </Empty>
          {isAnalyzing && <Progress value={null} className="upload-progress" />}
        </div>

        <aside className="explain-panel" aria-label="What the PDF inspector reports">
          <div className="explain-topline">
            <span className="eyebrow">WHAT YOU’LL SEE</span>
            <span className="index-number">01—04</span>
          </div>
          <div className="explain-list">
            <div className="explain-item">
              <span className="explain-index">01</span>
              <div><strong>Embedded images</strong><span>Format, dimensions, page use, encoded bytes</span></div>
            </div>
            <div className="explain-item">
              <span className="explain-index">02</span>
              <div><strong>Font programs</strong><span>Embedded font files and their sizes</span></div>
            </div>
            <div className="explain-item">
              <span className="explain-index">03</span>
              <div><strong>Page content</strong><span>Text and vector drawing streams</span></div>
            </div>
            <div className="explain-item">
              <span className="explain-index">04</span>
              <div><strong>Structure overhead</strong><span>Indexes, dictionaries, and other PDF bytes</span></div>
            </div>
          </div>
          <p className="privacy-note"><LockKeyhole aria-hidden="true" /> No upload server. Analysis runs in this tab.</p>
        </aside>
        {error && (
          <Alert className="file-error" variant="destructive">
            <CircleAlert />
            <AlertTitle>Could not inspect this PDF</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    )
  }

  const displayName = report.title || file.name
  const structureBytes = report.structureBytes
  const categories = [
    { key: "image" as const, label: "Images", value: report.totals.image },
    { key: "font" as const, label: "Fonts", value: report.totals.font },
    { key: "form" as const, label: "Forms", value: report.totals.form },
    { key: "content" as const, label: "Page content", value: report.totals.content },
    { key: "other" as const, label: "Other streams", value: report.totals.other },
    { key: "structure" as const, label: "PDF structure", value: structureBytes },
  ]
  const imageShare = report.totals.image / file.size
  const largestImage = report.assets.find((asset) => asset.category === "image")

  return (
    <div className="workspace-screen">
      <section className="document-strip" aria-label="Selected PDF">
        <div className="document-ident">
          <span className="document-file-icon"><FileText aria-hidden="true" /></span>
          <div className="document-copy">
            <div className="document-title-line">
              <h2 title={displayName}>{displayName}</h2>
              <Badge variant="outline">PDF</Badge>
            </div>
            <p>{file.name} <span>·</span> {formatBytes(file.size)}</p>
          </div>
        </div>
        <div className="document-actions">
          <span className="local-chip"><Check aria-hidden="true" /> Local file</span>
          <Button onClick={onExport} size="sm" variant="outline">
            <ArrowDownToLine data-icon="inline-start" /> Export CSV
          </Button>
          <Button aria-label="Choose a different PDF" onClick={onPickFile} size="icon-sm" variant="ghost">
            <Upload />
          </Button>
        </div>
      </section>

      <section className="metric-strip" aria-label="PDF summary">
        <div className="metric-item metric-main">
          <span>File size</span>
          <strong>{formatBytes(file.size)}</strong>
        </div>
        <Separator orientation="vertical" />
        <div className="metric-item">
          <span>Pages</span>
          <strong>{report.pageCount}</strong>
        </div>
        <Separator orientation="vertical" />
        <div className="metric-item">
          <span>Image streams</span>
          <strong>{report.imageCount}</strong>
        </div>
        <Separator orientation="vertical" />
        <div className="metric-item">
          <span>Embedded fonts</span>
          <strong>{report.embeddedFontCount}</strong>
        </div>
        <div className="stream-summary">
          <span>{formatBytes(report.streamBytes)} of encoded streams</span>
          <span>{((report.streamBytes / file.size) * 100).toFixed(0)}% of file</span>
        </div>
      </section>

      <section className="size-breakdown" aria-labelledby="size-breakdown-title">
        <div className="size-breakdown-heading">
          <div>
            <p className="eyebrow">FILE COMPOSITION</p>
            <h2 id="size-breakdown-title">Where the bytes live</h2>
          </div>
          <p className="breakdown-total">{formatBytes(file.size)} total</p>
        </div>
        <div className="segmented-bar" role="img" aria-label="PDF file size composition">
          {categories.map((category) => (
            <span
              aria-label={`${category.label}: ${formatBytes(category.value)}`}
              className={categoryInfo[category.key].className}
              key={category.key}
              style={{ width: `${Math.max(0, (category.value / file.size) * 100)}%` }}
            />
          ))}
        </div>
        <div className="breakdown-legend">
          {categories.map((category) => (
            <div className="legend-item" key={category.key}>
              <span className={cn("legend-dot", categoryInfo[category.key].className)} />
              <span>{category.label}</span>
              <strong>{((category.value / file.size) * 100).toFixed(1)}%</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="asset-workspace">
        <AssetTable
          assets={report.assets}
          file={file}
          fileSize={file.size}
          imageLoadError={imageLoadError}
          images={imageAssets}
          onReplaceDocument={onReplaceDocument}
        />
        <aside className="inspector-aside">
          <PdfPreview
            document={previewDocument}
            error={previewError}
            pageCount={report.pageCount}
            pageHeight={report.pageHeight}
            pageNumber={pageNumber}
            pageWidth={report.pageWidth}
            onPageChange={setPageNumber}
          />
          <section className="insight-block" aria-labelledby="optimization-note-title">
            <div className="insight-heading">
              <span className="insight-spark">↗</span>
              <p className="eyebrow">OPTIMIZATION NOTE</p>
            </div>
            <h3 id="optimization-note-title">
              {imageShare >= 0.2 ? "Images are the first place to look." : "Check the largest streams first."}
            </h3>
            <p>
              {largestImage && imageShare >= 0.2
                ? `Images account for ${(imageShare * 100).toFixed(0)}% of this PDF. Start with ${largestImage.name.replace(/ · \d+ \d+$/, "")}, currently ${formatBytes(largestImage.sizeBytes)}.`
                : "The table is sorted by encoded size. Review the biggest items and their pages before changing your source document."}
            </p>
          </section>
        </aside>
      </div>

      <Alert className="accuracy-note">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>About these numbers</AlertTitle>
        <AlertDescription>
          Stream sizes are counted once, including shared resources. PDF structure is the remaining file data; inline images and some compressed object groups can be included in page content or other streams.
        </AlertDescription>
      </Alert>
    </div>
  )
}

function ImageConverter() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [format, setFormat] = useState<OutputFormat>("image/webp")
  const [quality, setQuality] = useState(82)
  const [jpegEncoder, setJpegEncoder] = useState<JpegEncoder>(DEFAULT_JPEG_ENCODER)
  const [jpegContentProfile, setJpegContentProfile] = useState<JpegContentProfile>("photo")
  const [results, setResults] = useState<ConvertedImage[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [isConverting, setIsConverting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => () => {
    results.forEach((result) => URL.revokeObjectURL(result.previewUrl))
  }, [results])

  const addFiles = useCallback((incoming: File[]) => {
    const accepted: File[] = []
    const rejected: string[] = []

    for (const file of incoming) {
      if (/\.(png|jpe?g|webp|avif)$/i.test(file.name)) accepted.push(file)
      else rejected.push(file.name)
    }

    setErrors(rejected.map((name) => `${name}: choose a PNG, JPEG, WebP, or AVIF image.`))
    if (accepted.length === 0) return

    setFiles((previous) => {
      const known = new Set(previous.map((file) => `${file.name}:${file.size}:${file.lastModified}`))
      const additions = accepted.filter((file) => {
        const key = `${file.name}:${file.size}:${file.lastModified}`
        if (known.has(key)) return false
        known.add(key)
        return true
      })
      return [...previous, ...additions]
    })
    setResults([])
    setProgress(0)
  }, [])

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ""
  }

  const runConversion = async () => {
    if (files.length === 0 || isConverting) return

    setIsConverting(true)
    setProgress(0)
    setErrors([])
    setResults([])
    const converted = new Array<ConvertedImage | undefined>(files.length)
    const conversionErrors: string[] = []
    const nextIndex = { value: 0 }
    let finished = 0

    const worker = async () => {
      while (nextIndex.value < files.length) {
        const index = nextIndex.value
        nextIndex.value += 1
        const file = files[index]
        try {
          converted[index] = await convertImage(file, format, quality / 100, jpegEncoder, jpegContentProfile)
        } catch (conversionError) {
          const message = conversionError instanceof Error ? conversionError.message : "Could not convert this image."
          conversionErrors.push(`${file.name}: ${message}`)
        }
        finished += 1
        setProgress(finished)
      }
    }

    const concurrency = format === "image/avif" ? 1 : 3
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()))
    setResults(converted.filter((result): result is ConvertedImage => Boolean(result)))
    setErrors(conversionErrors)
    setIsConverting(false)
  }

  const downloadAll = async () => {
    if (results.length === 0) return
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    const names = new Map<string, number>()

    for (const result of results) {
      const count = names.get(result.outputName) ?? 0
      names.set(result.outputName, count + 1)
      const uniqueName = count === 0
        ? result.outputName
        : result.outputName.replace(/(\.[^.]+)$/, ` (${count + 1})$1`)
      zip.file(uniqueName, result.blob)
    }

    const archive = await zip.generateAsync({ type: "blob" })
    downloadBlob(archive, "converted-images.zip")
  }

  const removeFile = (fileToRemove: File) => {
    const key = `${fileToRemove.name}:${fileToRemove.size}:${fileToRemove.lastModified}`
    setFiles((previous) => previous.filter((file) => `${file.name}:${file.size}:${file.lastModified}` !== key))
    setResults([])
  }

  return (
    <div className="converter-workspace workspace-screen">
      <div className="converter-intro">
        <div>
          <p className="eyebrow">BATCH IMAGE TOOL</p>
          <h2>Convert images before they reach the PDF.</h2>
          <p>Choose a format and quality, then download the converted files together or one at a time.</p>
        </div>
        <div className="local-chip"><LockKeyhole aria-hidden="true" /> Runs in this browser</div>
      </div>

      <div className="converter-layout">
        <div className="converter-controls">
          <div
            className={cn("image-dropzone", dragOver && "is-dragging")}
            onDragEnter={(event) => {
              event.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              setDragOver(false)
              addFiles(Array.from(event.dataTransfer.files))
            }}
          >
            <input
              ref={inputRef}
              accept="image/png,image/jpeg,image/webp,image/avif,.png,.jpg,.jpeg,.webp,.avif"
              className="sr-only"
              multiple
              onChange={handleFiles}
              type="file"
            />
            <span className="image-drop-icon"><FileImage aria-hidden="true" /></span>
            <div>
              <h3>Drop images here</h3>
              <p>PNG, JPEG, WebP, and AVIF · Select as many as you need</p>
            </div>
            <Button onClick={() => inputRef.current?.click()} variant="outline">
              <Upload data-icon="inline-start" /> Browse files
            </Button>
          </div>

          <div className="conversion-settings">
            <FieldLabelLine label="Output format" description="Choose a format for every selected file." />
            <ToggleGroup
              aria-label="Image output format"
              className="format-options"
              multiple={false}
              onValueChange={(values) => {
                if (values[0]) {
                  setFormat(values[0] as OutputFormat)
                  setResults([])
                }
              }}
              value={[format]}
              variant="outline"
              size="sm"
            >
              {formatOptions.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} className="format-option">
                  <span>{option.label}</span>
                  <small>{option.detail}</small>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {format === "image/jpeg" && (
              <div className="jpeg-encoder-control">
                <FieldLabelLine label="JPEG encoder" description="Both choices produce standard JPEG files." />
                <ToggleGroup
                  aria-label="Bulk JPEG encoder"
                  className="jpeg-encoder-options"
                  multiple={false}
                  onValueChange={(values) => {
                    const nextEncoder = values[0] as JpegEncoder | undefined
                    if (nextEncoder) {
                      setJpegEncoder(nextEncoder)
                      setResults([])
                    }
                  }}
                  value={[jpegEncoder]}
                  variant="outline"
                  size="sm"
                >
                  {jpegEncoderOptions.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="format-option">
                      <span>{option.label}</span>
                      <small>{option.detail}</small>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldLabelLine label="Image content" description="Text detail keeps full color sampling; photo favors smaller files." />
                <ToggleGroup
                  aria-label="JPEG image content profile"
                  className="image-profile-options"
                  multiple={false}
                  onValueChange={(values) => {
                    const nextProfile = values[0] as JpegContentProfile | undefined
                    if (nextProfile) {
                      setJpegContentProfile(nextProfile)
                      setResults([])
                    }
                  }}
                  value={[jpegContentProfile]}
                  variant="outline"
                  size="sm"
                >
                  <ToggleGroupItem value="photo">Photo</ToggleGroupItem>
                  <ToggleGroupItem value="text">Text & detail</ToggleGroupItem>
                </ToggleGroup>
              </div>
            )}

            <div className="quality-control">
              <div className="quality-heading">
                <Label htmlFor="image-quality">Quality</Label>
                <span>{format === "image/png" ? "Lossless" : `${quality}%`}</span>
              </div>
              <Slider
                aria-label="Image quality"
                disabled={format === "image/png"}
                id="image-quality"
                max={100}
                min={10}
                onValueChange={(value) => {
                  const nextQuality = Array.isArray(value) ? value[0] : value
                  if (typeof nextQuality === "number") {
                    setQuality(nextQuality)
                    setResults([])
                  }
                }}
                step={1}
                value={[quality]}
              />
              <p>{format === "image/png" ? "PNG is exported losslessly." : format === "image/avif" ? "AVIF is compact; encoding may take longer." : "Lower quality creates smaller files. Text & detail mode avoids color subsampling for JPEG."}</p>
            </div>

            <Separator />
            <div className="conversion-action-row">
              <div className="queue-count">
                <strong>{files.length}</strong> {files.length === 1 ? "image" : "images"} selected
              </div>
              <Button disabled={files.length === 0 || isConverting} onClick={runConversion} size="lg">
                {isConverting
                  ? <Spinner data-icon="inline-start" />
                  : <ArrowRight data-icon="inline-start" />}
                {isConverting ? "Converting" : "Convert images"}
              </Button>
            </div>
          </div>

          {isConverting && (
            <div className="conversion-progress">
              <div className="progress-copy"><span>Converting images</span><span>{progress} / {files.length}</span></div>
              <Progress value={(progress / files.length) * 100} />
            </div>
          )}

          {errors.length > 0 && (
            <Alert variant="destructive" className="conversion-error">
              <CircleAlert />
              <AlertTitle>Some files could not be processed</AlertTitle>
              <AlertDescription>{errors.join(" ")}</AlertDescription>
            </Alert>
          )}

          <p className="conversion-note">
            JPEG has no transparency; transparent areas are filled with white. WebP and AVIF are standalone image formats and cannot be embedded in a broadly compatible PDF.
          </p>
        </div>

        <section className="conversion-results" aria-labelledby="conversion-results-title">
          <div className="section-heading results-heading">
            <div>
              <p className="eyebrow">OUTPUT QUEUE</p>
              <h2 id="conversion-results-title">Converted images</h2>
            </div>
            {results.length > 0 && (
              <Button onClick={() => void downloadAll()} size="sm" variant="outline">
                <ArrowDownToLine data-icon="inline-start" /> Download all
              </Button>
            )}
          </div>

          {files.length === 0 && results.length === 0 ? (
            <Empty className="results-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon"><ImageIcon /></EmptyMedia>
                <EmptyTitle>No images selected</EmptyTitle>
                <EmptyDescription>Add a batch to compare original and converted file sizes.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="image-list">
              {files.map((file) => {
                const result = results.find((item) => item.source === file)
                const saved = result ? file.size - result.blob.size : 0
                return (
                  <div className="image-list-item" key={`${file.name}:${file.size}:${file.lastModified}`}>
                    <div className="image-preview-thumb">
                      {result ? <img src={result.previewUrl} alt="" /> : <FileImage aria-hidden="true" />}
                    </div>
                    <div className="image-list-copy">
                      <strong title={file.name}>{file.name}</strong>
                      <span>
                        {formatBytes(file.size)}
                        {result && <> <ArrowRight aria-hidden="true" /> {formatBytes(result.blob.size)}</>}
                      </span>
                    </div>
                    {result && (
                      <div className={cn("image-saving", saved < 0 && "is-larger")}>
                        {saved >= 0 ? `${Math.round((saved / file.size) * 100)}% smaller` : `${Math.round((Math.abs(saved) / file.size) * 100)}% larger`}
                      </div>
                    )}
                    <Button
                      aria-label={`Remove ${file.name}`}
                      onClick={() => removeFile(file)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                    {result && (
                      <Button
                        aria-label={`Download ${result.outputName}`}
                        onClick={() => downloadBlob(result.blob, result.outputName)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ArrowDownToLine />
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {results.length > 0 && (
            <div className="results-summary">
              <span>{results.length} ready to download</span>
              <span>{formatBytes(results.reduce((sum, result) => sum + result.blob.size, 0))} combined</span>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function FieldLabelLine({ label, description }: { label: string; description: string }) {
  return (
    <div className="field-label-line">
      <Label>{label}</Label>
      <p>{description}</p>
    </div>
  )
}

function App() {
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const analysisRunRef = useRef(0)
  const previewTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const [tool, setTool] = useState<ToolMode>("inspect")
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfReport, setPdfReport] = useState<PdfReport | null>(null)
  const [pdfImageAssets, setPdfImageAssets] = useState<PdfImageAsset[]>([])
  const [pdfImageError, setPdfImageError] = useState<string | null>(null)
  const [previewDocument, setPreviewDocument] = useState<PDFDocumentProxy | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => () => {
    void previewTaskRef.current?.destroy()
  }, [])

  useEffect(() => () => {
    pdfImageAssets.forEach((asset) => {
      if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl)
    })
  }, [pdfImageAssets])

  const inspectFile = useCallback(async (file: File) => {
    const runId = analysisRunRef.current + 1
    analysisRunRef.current = runId
    const previousPreviewTask = previewTaskRef.current
    previewTaskRef.current = null
    if (previousPreviewTask) void previousPreviewTask.destroy()

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setPdfError("Choose a file with a .pdf extension.")
      setPdfFile(null)
      setPdfReport(null)
      setPdfImageAssets([])
      setPdfImageError(null)
      setPreviewDocument(null)
      setIsAnalyzing(false)
      return
    }

    setPdfFile(file)
    setPdfReport(null)
    setPdfImageAssets([])
    setPdfImageError(null)
    setPdfError(null)
    setPreviewError(null)
    setPreviewDocument(null)
    setIsAnalyzing(true)

    try {
      const buffer = await file.arrayBuffer()
      const streamData = new Uint8Array(buffer.slice(0))
      const previewData = new Uint8Array(buffer.slice(0))
      const [{ analyzePdf }, { loadPdfImageAssets }, pdfjs] = await Promise.all([
        import("@/lib/pdf-analysis"),
        import("@/lib/pdf-optimization"),
        import("pdfjs-dist"),
      ])
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      const previewTask = pdfjs.getDocument({ data: previewData })
      previewTaskRef.current = previewTask
      const [analysisResult, previewResult, imageResult] = await Promise.allSettled([
        analyzePdf(streamData, file.size),
        previewTask.promise,
        loadPdfImageAssets(new Uint8Array(buffer.slice(0))),
      ])

      if (runId !== analysisRunRef.current) {
        if (previewTaskRef.current === previewTask) previewTaskRef.current = null
        void previewTask.destroy()
        if (imageResult.status === "fulfilled") {
          imageResult.value.forEach((asset) => {
            if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl)
          })
        }
        return
      }

      if (analysisResult.status === "rejected") {
        if (previewTaskRef.current === previewTask) previewTaskRef.current = null
        void previewTask.destroy()
        if (imageResult.status === "fulfilled") {
          imageResult.value.forEach((asset) => {
            if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl)
          })
        }
        throw analysisResult.reason
      }
      setPdfReport(analysisResult.value)
      if (imageResult.status === "fulfilled") setPdfImageAssets(imageResult.value)
      else setPdfImageError("The image previews could not be prepared for this PDF.")

      if (previewResult.status === "fulfilled") setPreviewDocument(previewResult.value)
      else {
        if (previewTaskRef.current === previewTask) previewTaskRef.current = null
        void previewTask.destroy()
        setPreviewError("The size report is ready, but this PDF could not be rendered in the preview.")
      }
    } catch (error) {
      if (runId === analysisRunRef.current) {
        setPdfError(friendlyError(error))
        setPdfFile(null)
        setPdfReport(null)
        setPdfImageAssets([])
      }
    } finally {
      if (runId === analysisRunRef.current) setIsAnalyzing(false)
    }
  }, [])

  const exportCsv = () => {
    if (!pdfReport || !pdfFile) return
    const rows = [
      ["Name", "Type", "Details", "Pages", "Encoded bytes", "% of PDF"],
      ...pdfReport.assets.map((asset) => [
        asset.name,
        asset.category,
        asset.detail,
        asset.pages.join("; ") || "Not mapped",
        asset.sizeBytes,
        ((asset.sizeBytes / pdfFile.size) * 100).toFixed(2),
      ]),
    ]
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${pdfFile.name.replace(/\.pdf$/i, "")}-assets.csv`)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="#top" aria-label="Pageweight home">
          <span className="brand-mark"><Layers2 aria-hidden="true" /></span>
          <span className="brand-copy"><strong>pageweight</strong><small>DOCUMENT WORKSPACE</small></span>
        </a>
        <div className="topbar-status"><span className="status-dot" /> Files stay on this device</div>
      </header>

      <main id="top" className="main-content">
        <div className="page-heading">
          <div className="page-heading-copy">
            <p className="eyebrow">LOCAL PDF TOOLS <span>/</span> 01</p>
            <h1>PDF asset inspector</h1>
            <p>Inspect embedded streams, preview images, and reduce image size directly in a copy of the PDF.</p>
          </div>
          <div className="page-heading-mark" aria-hidden="true"><ScanSearch /></div>
        </div>

        <Tabs
          className="tool-tabs"
          onValueChange={(value) => setTool(value as ToolMode)}
          value={tool}
        >
          <TabsList className="tool-tab-list" variant="line">
            <TabsTrigger value="inspect"><ScanSearch data-icon="inline-start" /> PDF inspector</TabsTrigger>
            <TabsTrigger value="convert"><ArrowLeftRight data-icon="inline-start" /> Image converter</TabsTrigger>
          </TabsList>
          <TabsContent className="tool-panel" value="inspect">
            <input
              ref={pdfInputRef}
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file) void inspectFile(file)
                event.currentTarget.value = ""
              }}
              type="file"
            />
            <PdfWorkspace
              error={pdfError}
              file={pdfFile}
              imageAssets={pdfImageAssets}
              imageLoadError={pdfImageError}
              isAnalyzing={isAnalyzing}
              onDropFile={(file) => void inspectFile(file)}
              onExport={exportCsv}
              onPickFile={() => pdfInputRef.current?.click()}
              onReplaceDocument={(file) => void inspectFile(file)}
              previewDocument={previewDocument}
              previewError={previewError}
              report={pdfReport}
            />
          </TabsContent>
          <TabsContent className="tool-panel" value="convert">
            <ImageConverter />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="app-footer">
        <span>PAGEWEIGHT · BROWSER-BASED PDF ANALYSIS</span>
        <span><LockKeyhole aria-hidden="true" /> Your files are processed locally and never uploaded.</span>
      </footer>
    </div>
  )
}

export default App
