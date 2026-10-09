import { useEffect, useRef, useState, type ReactNode } from 'react';
import { systemReport, type ServerGpuInfo } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    openSystemReport?: () => void;
  }
}

type Tone = 'ok' | 'warn' | 'bad';

interface SectionResult {
  status: string;
  tone: Tone;
  details: ReactNode;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** WebGL in this browser, which draws the 3D previews. */
function clientGpu(): SectionResult {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) {
      return { status: '✗ Not Detected', tone: 'bad', details: 'WebGL is not available. 3D rendering may be limited or unavailable.' };
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const details = debugInfo ? (
      <>
        <div>Vendor: {String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))}</div>
        <div>Renderer: {String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))}</div>
      </>
    ) : (
      'WebGL is available but detailed GPU information is not accessible.'
    );
    return { status: '✓ Detected', tone: 'ok', details };
  } catch (error) {
    return { status: '✗ Not Detected', tone: 'bad', details: `Error detecting GPU: ${errorText(error)}` };
  }
}

function serverGpu(info: ServerGpuInfo | null): SectionResult {
  if (!info) return { status: '✗ Unavailable', tone: 'bad', details: 'No response from the JusttPrint backend.' };
  if (info.error) return { status: '✗ Error', tone: 'bad', details: info.error };

  const backend = info.glBackend || 'unknown';
  const backendLabel = backend === 'swiftshader' ? 'SwiftShader (CPU / software WebGL)' : backend === 'nvidia' ? 'NVIDIA hardware WebGL (requested)' : backend;
  const nvidia = info.nvidia;

  let status = '✗ Not Detected';
  let tone: Tone = 'bad';
  if (info.usingSwiftShader && info.available) {
    status = nvidia?.available ? '⚠ Host NVIDIA visible — WebGL on SwiftShader' : '✓ SwiftShader (software)';
    tone = nvidia?.available ? 'warn' : 'ok';
  } else if (info.available && !info.usingSwiftShader) {
    status = '✓ Hardware GPU in use';
    tone = 'ok';
  } else if (nvidia?.available) {
    status = '⚠ NVIDIA visible — WebGL status unknown';
    tone = 'warn';
  }

  const details = (
    <>
      <div>
        <strong>GL backend:</strong> {backendLabel}
      </div>
      {info.activeRenderer && (
        <div>
          <strong>Thumbnail renderer's GPU:</strong> {info.activeRenderer}
        </div>
      )}
      {info.workerWebgl?.renderer && (
        <div className="system-report-indent">
          {[
            info.workerWebgl.vendor,
            info.workerWebgl.webgl2 ? 'WebGL 2' : 'WebGL 1',
            info.workerWebgl.version,
            info.workerWebgl.maxTextureSize ? `textures up to ${info.workerWebgl.maxTextureSize} px` : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {nvidia?.available && nvidia.gpus ? (
        <>
          <div className="system-report-gap">
            <strong>nvidia-smi:</strong>
          </div>
          {nvidia.gpus.map((gpu) => (
            <div key={gpu.index} className="system-report-indent">
              [{gpu.index}] {gpu.name} — driver {gpu.driverVersion}, mem {gpu.memoryUsedMiB}/{gpu.memoryTotalMiB} MiB, util {gpu.utilizationPercent}%
            </div>
          ))}
        </>
      ) : (
        nvidia?.message && (
          <div>
            <strong>nvidia-smi:</strong> {nvidia.message}
          </div>
        )
      )}
      {info.nvidiaVisibleDevices && (
        <div>
          <strong>NVIDIA_VISIBLE_DEVICES:</strong> {info.nvidiaVisibleDevices}
        </div>
      )}
      {info.nvidiaDriverCapabilities ? (
        <div>
          <strong>NVIDIA_DRIVER_CAPABILITIES:</strong> {info.nvidiaDriverCapabilities}
        </div>
      ) : (
        info.serverMode && (
          <div>
            <strong>NVIDIA_DRIVER_CAPABILITIES:</strong> <em>unset</em>
          </div>
        )
      )}
      {info.warnings && info.warnings.length > 0 && (
        <div className="system-report-warnings">
          <div className="system-report-gap">
            <strong>Warnings:</strong>
          </div>
          {info.warnings.map((warning) => (
            <div key={warning} className="system-report-indent">
              • {warning}
            </div>
          ))}
        </div>
      )}
    </>
  );
  return { status, tone, details };
}

function Section({
  title,
  description,
  result,
  pending,
  id
}: {
  title: string;
  description?: string;
  result: SectionResult | null;
  pending: string;
  id: string;
}) {
  return (
    <div className="system-report-section" id={`system-report-${id}`}>
      <h3>{title}</h3>
      {description && <p className="system-report-description">{description}</p>}
      <div>
        <strong>Status: </strong>
        <span className={result ? `system-report-status-${result.tone}` : undefined}>{result ? result.status : pending}</span>
      </div>
      {result && <div className="system-report-details">{result.details}</div>}
    </div>
  );
}

/**
 * Help → System Report: WebGL in this browser, the server's GPU, and file system and database
 * benchmarks. Each section fills in when its check finishes. Registers window.openSystemReport.
 */
export function SystemReportDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [client, setClient] = useState<SectionResult | null>(null);
  const [server, setServer] = useState<SectionResult | null>(null);
  const [filesystem, setFilesystem] = useState<SectionResult | null>(null);
  const [db, setDb] = useState<SectionResult | null>(null);

  useEffect(() => {
    let openCount = 0;
    return exposeGlobal('openSystemReport', () => {
      const open = ++openCount;
      const current = () => open === openCount;
      setClient(null);
      setServer(null);
      setFilesystem(null);
      setDb(null);
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
      setClient(clientGpu());

      systemReport
        .gpu()
        .then((info) => {
          if (current()) setServer(serverGpu(info));
        })
        .catch((error) => {
          if (current()) setServer({ status: '✗ Error', tone: 'bad', details: errorText(error) });
        });

      // The benchmarks run one after the other, so they don't slow each other down.
      (async () => {
        try {
          const result = await systemReport.benchmarkFilesystem();
          if (!current()) return;
          setFilesystem(
            result.success
              ? {
                  status: '✓ Completed',
                  tone: 'ok',
                  details: (
                    <>
                      <div>
                        Write: {result.write.speedMBps} MB/s ({result.write.time}ms for {result.iterations} operations)
                      </div>
                      <div>
                        Read: {result.read.speedMBps} MB/s ({result.read.time}ms for {result.iterations} operations)
                      </div>
                    </>
                  )
                }
              : { status: '✗ Failed', tone: 'bad', details: `Error: ${result.error || 'Unknown error'}` }
          );
        } catch (error) {
          if (current()) setFilesystem({ status: '✗ Error', tone: 'bad', details: `Error: ${errorText(error)}` });
        }
        if (!current()) return;
        try {
          const result = await systemReport.benchmarkDatabase();
          if (!current()) return;
          setDb(
            result.success
              ? {
                  status: '✓ Completed',
                  tone: 'ok',
                  details: (
                    <>
                      <div>
                        Write: {result.write.opsPerSec} ops/sec ({result.write.time}ms for {result.write.operations} operations)
                      </div>
                      <div>
                        Read: {result.read.opsPerSec} ops/sec ({result.read.time}ms for {result.read.operations} operations)
                      </div>
                    </>
                  )
                }
              : { status: '✗ Failed', tone: 'bad', details: `Error: ${result.error || 'Unknown error'}` }
          );
        } catch (error) {
          if (current()) setDb({ status: '✗ Error', tone: 'bad', details: `Error: ${errorText(error)}` });
        }
      })();
    });
  }, []);

  return (
    <ModalDialog id="system-report-dialog" title="System Report" dialogRef={dialogRef}>
      <div className="system-report-content" tabIndex={0} role="region" aria-label="System report">
        <Section
          id="client-gpu"
          title="Client GPU (this browser)"
          description="Used for interactive 3D previews in the UI."
          result={client}
          pending="Checking..."
        />
        <Section
          id="server-gpu"
          title="JusttPrint Backend GPU"
          description="Used to render thumbnails in the container (headless Chromium)."
          result={server}
          pending="Checking..."
        />
        <Section id="filesystem" title="File System Benchmark" result={filesystem} pending="Running benchmark..." />
        <Section id="database" title="Database Performance" result={db} pending={filesystem ? 'Running benchmark...' : 'Waiting...'} />
      </div>
    </ModalDialog>
  );
}
