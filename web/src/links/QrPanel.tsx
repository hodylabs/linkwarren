import { forwardRef, useMemo } from "react";
import { useApp } from "../state";
import { download, fileName, qrMatrix, qrPath, qrPng, qrSvg, qrText } from "./qr";

const MARGIN = 4;

/** The detail panel's QR section. The Download SVG button is the focus target of the Q key. */
export const QrPanel = forwardRef<HTMLButtonElement, { host: string; slug: string }>(function QrPanel({ host, slug }, ref) {
  const app = useApp();
  const m = useMemo(() => qrMatrix(qrText(host, slug)), [host, slug]);
  const size = m.length + 2 * MARGIN;
  const label = `QR code for ${host}/${slug}`;

  const svg = () => download(fileName(host, slug, "svg"), new Blob([qrSvg(m, MARGIN)], { type: "image/svg+xml" }));
  const png = () => qrPng(m, 16, MARGIN).then((b) => download(fileName(host, slug, "png"), b), () => app.announce("Could not make the PNG"));

  return (
    <div className="sect">
      <h3>QR code</h3>
      <div className="qr">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
          <rect width={size} height={size} fill="#FFFFFF" />
          <path fill="#15181D" d={qrPath(m, MARGIN)} />
        </svg>
        <div>
          <p>Encodes the short link, so you can change the destination after printing. Download SVG or PNG.</p>
          <div className="row">
            <button type="button" className="btn" ref={ref} onClick={svg} aria-keyshortcuts="Q">
              Download SVG <kbd>Q</kbd>
            </button>
            <button type="button" className="btn" onClick={() => void png()}>
              Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
