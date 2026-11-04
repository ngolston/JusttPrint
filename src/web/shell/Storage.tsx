import { library, type LibraryStorage } from '../api';
import { ProgressBar } from '../components/Panel';
import { useLibraryData } from './libraryData';

/** "12.4 GB", "820 MB", "0 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Library Storage on the Settings page: the library's files, and how full their volume is. */
export function StorageCard() {
  const storage = useLibraryData<LibraryStorage>(library.storage);
  if (!storage) return null;
  const volume = storage.volume;
  const percent = volume ? Math.round((volume.usedBytes / volume.totalBytes) * 100) : 0;
  return (
    <section className="jp-card jp-storage" aria-labelledby="jp-storage-title" title={volume ? `Volume: ${volume.path}` : undefined}>
      <div className="jp-storage__figures">
        <h2 className="jp-storage__title" id="jp-storage-title">
          Library Storage
        </h2>
        {volume && <span>{percent}%</span>}
      </div>
      <p className="jp-storage__line">
        {formatBytes(storage.libraryBytes)} in {storage.modelCount.toLocaleString()} {storage.modelCount === 1 ? 'model' : 'models'}
      </p>
      {volume && (
        <>
          <ProgressBar value={volume.usedBytes} max={volume.totalBytes} label="Library volume used" />
          <p className="jp-storage__line">
            Volume: {formatBytes(volume.usedBytes)} of {formatBytes(volume.totalBytes)} used
          </p>
        </>
      )}
    </section>
  );
}
