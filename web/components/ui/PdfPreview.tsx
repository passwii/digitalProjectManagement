"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const PAGE_WIDTH = 800;

export default function PdfPreview({
  url,
  filename,
  onRetry,
}: {
  url: string;
  filename: string;
  onRetry: () => void;
}) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState(false);
  const previousUrl = useRef(url);

  useEffect(() => {
    if (previousUrl.current === url) {
      return;
    }

    previousUrl.current = url;
    setError(false);
    setNumPages(0);
  }, [url]);

  const handleLoadSuccess = useCallback(({ numPages: pages }: { numPages: number }) => {
    setNumPages(pages);
    setError(false);
  }, []);

  const handleLoadError = useCallback(() => {
    setNumPages(0);
    setError(true);
  }, []);

  const handleRetry = () => {
    onRetry();
  };

  return (
    <section aria-label={`${filename} PDF 预览`}>
      <div>
        <button
          type="button"
          aria-label="缩小 PDF"
          onClick={() => setScale((value) => Math.max(0.75, value - 0.25))}
        >
          −
        </button>
        <span>{numPages ? `${numPages} 页` : "正在加载 PDF…"}</span>
        <button
          type="button"
          aria-label="放大 PDF"
          onClick={() => setScale((value) => Math.min(2.5, value + 0.25))}
        >
          ＋
        </button>
        <button type="button" aria-label="重置 PDF 缩放" onClick={() => setScale(1)}>
          适应宽度
        </button>
      </div>

      {error ? (
        <div role="alert">
          <span>PDF 加载失败</span>
          <button type="button" onClick={handleRetry}>重试</button>
        </div>
      ) : (
        <Document
          key={url}
          file={url}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
        >
          {Array.from({ length: numPages }, (_, index) => (
            <Page
              key={index + 1}
              pageNumber={index + 1}
              width={PAGE_WIDTH * scale}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          ))}
        </Document>
      )}
    </section>
  );
}
