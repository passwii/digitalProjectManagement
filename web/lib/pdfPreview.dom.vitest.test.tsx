// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, fireEvent, render } from "@testing-library/react";
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

afterEach(() => vi.clearAllMocks());

describe("PDF 公共预览", () => {
  it("加载页数后渲染全部页面，并可改变缩放比例", async () => {
    const { getByRole, getByTestId } = render(
      <PdfPreview url="blob:pdf-1" filename="合同.pdf" onRetry={() => {}} />,
    );
    await act(async () => {});

    expect(getByTestId("pdf-page-1")).not.toBeNull();
    expect(getByTestId("pdf-page-2")).not.toBeNull();
    const before = getByTestId("pdf-page-1").getAttribute("data-width");

    fireEvent.click(getByRole("button", { name: "放大 PDF" }));
    expect(getByTestId("pdf-page-1").getAttribute("data-width")).not.toBe(
      before,
    );
  });

  it("PDF 解析失败时显示错误并提供重试入口", async () => {
    const onRetry = vi.fn();
    const { getByText, getByRole } = render(
      <PdfPreview url="blob:pdf-error" filename="合同.pdf" onRetry={onRetry} />,
    );
    await act(async () => {});

    expect(getByText("PDF 加载失败")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
