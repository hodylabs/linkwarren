import { forwardRef, useMemo } from "react";
import { Icon } from "../shell/ui";
import { useApp } from "../state";
import { download, fileName, qrMatrix, qrPath, qrPng, qrSvg, qrText } from "./qr";

const MARGIN = 4;

/** A short link's QR code and its downloads (the QR code sheet of a link). Download SVG takes focus when the sheet opens. */
export const QrPanel = forwardRef<HTMLButtonElement, { host: string; slug: string }>(function QrPanel({ host, slug }, ref) {
  const app = useApp();
  const m = useMemo(() => qrMatrix(qrText(host, slug)), [host, slug]);
  const size = m.length + 2 * MARGIN;
  const label = `QR code for ${host}/${slug}`;

  const svg = () => download(fileName(host, slug, "svg"), new Blob([qrSvg(m, MARGIN)], { type: "image/svg+xml" }));
  const png = () => qrPng(m, 16, MARGIN).then((b) => download(fileName(host, slug, "png"), b), () => app.announce("Could not make the PNG"));

  return (
    <div className="qr-edit">
      <div className="qr">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
          <rect width={size} height={size} fill="#FFFFFF" />
          <path fill="#15181D" d={qrPath(m, MARGIN)} />
        </svg>
        <div>
          <p>Encodes the short link, so you can change the destination after printing. Download SVG or PNG.</p>
          <div className="row">
            <button type="button" className="btn sm" ref={ref} onClick={svg}>
              <Icon name="dl" />
              Download SVG
            </button>
            <button type="button" className="btn sm" onClick={() => void png()}>
              <Icon name="dl" />
              Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
