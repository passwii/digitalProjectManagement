// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PdfPreview from "../components/ui/PdfPreview";

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
  Document: ({
    file,
    children,
    onLoadSuccess,
    onLoadError,
  }: {
    file?: string;
    children: ReactNode;
    onLoadSuccess?: (value: { numPages: number }) => void;
    onLoadError?: (error: Error) => void;
  }) => {
    useEffect(() => {
      if (String(file).includes("error")) {
        onLoadError?.(new Error("parse error"));
      } else {
        onLoadSuccess?.({ numPages: 2 });
      }
    }, [file, onLoadError, onLoadSuccess]);
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber, width }: { pageNumber: number; width?: number }) => (
    <div data-testid={`pdf-page-${pageNumber}`} data-width={width} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PDF 公共预览", () => {
  it("加载页数后渲染全部页面，并可改变缩放比例", async () => {
    const { container, getByRole, getByTestId } = render(
      <PdfPreview url="blob:pdf-1" filename="合同.pdf" onRetry={() => {}} />,
    );
    await act(async () => {});

    expect(container.querySelector("section.pdf-preview")).not.toBeNull();
    expect(container.querySelector(".pdf-preview-toolbar")).not.toBeNull();
    expect(container.querySelector(".pdf-preview-pages")).not.toBeNull();
    expect(getByTestId("pdf-page-1")).not.toBeNull();
    expect(getByTestId("pdf-page-2")).not.toBeNull();
    expect(getByTestId("pdf-page-1").parentElement?.classList.contains("pdf-preview-page")).toBe(true);
    expect(getByTestId("pdf-page-2").parentElement?.classList.contains("pdf-preview-page")).toBe(true);
    const before = getByTestId("pdf-page-1").getAttribute("data-width");

    fireEvent.click(getByRole("button", { name: "放大 PDF" }));
    expect(getByTestId("pdf-page-1").getAttribute("data-width")).not.toBe(
      before,
    );
  });

  it("父级换用新的 Blob URL 后会清除错误并重新渲染全部页面", async () => {
    const onRetry = vi.fn();
    function RetryHarness() {
      const [url, setUrl] = useState("blob:pdf-error");

      return (
        <PdfPreview
          url={url}
          filename="合同.pdf"
          onRetry={() => {
            onRetry();
            setTimeout(() => setUrl("blob:pdf-recovered"), 0);
          }}
        />
      );
    }

    const { getByText, getByRole, getByTestId, queryByText } = render(<RetryHarness />);
    await act(async () => {});

    expect(getByText("PDF 加载失败")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(queryByText("PDF 加载失败")).toBeNull();
    expect(getByTestId("pdf-page-1")).not.toBeNull();
    expect(getByTestId("pdf-page-2")).not.toBeNull();
  });
});
