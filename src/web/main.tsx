/**
 * React screens, mounted into the existing page one at a time. Each screen replaces markup in
 * index.html and the matching code in renderer.js, and keeps the global function the rest of
 * the page calls to open it (window.openServerAccess, window.openTagManager, ...).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AboutDialog } from './AboutDialog';
import { AiConfigDialog } from './AiConfigDialog';
import { BackupRestoreDialog } from './BackupRestoreDialog';
import { BrowserExtensionSettingsDialog } from './BrowserExtensionSettingsDialog';
import { DedupDialog } from './DedupDialog';
import { BundleDetails } from './details/BundleDetails';
import { DetailsFields } from './details/DetailsFields';
import { DetailsFilaments } from './details/DetailsFilaments';
import { DetailsNotes } from './details/DetailsNotes';
import { DetailsPath } from './details/DetailsPath';
import { FilamentManagerDialog } from './FilamentManagerDialog';
import { FileTypeSettingsDialog } from './FileTypeSettingsDialog';
import { HttpsSettingsDialog } from './HttpsSettingsDialog';
import { LibraryGrid } from './grid/LibraryGrid';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { ManageThumbnailsDialog } from './ManageThumbnailsDialog';
import { McpServerSettingsDialog } from './McpServerSettingsDialog';
import { MetadataEditorDialog } from './MetadataEditorDialog';
import { MultiEditPanel } from './details/MultiEditPanel';
import { OrganizeLibraryDialog } from './OrganizeLibraryDialog';
import { PartsManagerDialog } from './PartsManagerDialog';
import { PerformanceSettingsDialog } from './PerformanceSettingsDialog';
import { PrinterManagerDialog } from './PrinterManagerDialog';
import './preview/files';
import './thumbnails';
import './parse';
import './filters/search';
import { Sidebar } from './filters/Sidebar';
import { FolderTree } from './folders/FolderTree';
import { PreviewDialog } from './preview/PreviewDialog';
import { PrintHistory } from './print/PrintHistory';
import { PurgeModelsDialog } from './PurgeModelsDialog';
import { ServerAccessDialog } from './ServerAccessDialog';
import { SlicerSettingsDialog } from './SlicerSettingsDialog';
import { StatsDialog } from './StatsDialog';
import { StlHomeDialog } from './StlHomeDialog';
import { SystemReportDialog } from './SystemReportDialog';
import { TagManagerDialog } from './TagManagerDialog';
import { ThemeSettingsDialog } from './ThemeSettingsDialog';

function Screens() {
  return (
    <>
      <ServerAccessDialog />
      <TagManagerDialog />
      <PartsManagerDialog />
      <FilamentManagerDialog />
      <PrinterManagerDialog />
      <StatsDialog />
      <SystemReportDialog />
      <BackupRestoreDialog />
      <KeyboardShortcutsDialog />
      <AboutDialog />
      <PerformanceSettingsDialog />
      <McpServerSettingsDialog />
      <BrowserExtensionSettingsDialog />
      <FileTypeSettingsDialog />
      <HttpsSettingsDialog />
      <AiConfigDialog />
      <PurgeModelsDialog />
      <ThemeSettingsDialog />
      <SlicerSettingsDialog />
      <MetadataEditorDialog />
      <StlHomeDialog />
      <OrganizeLibraryDialog />
      <DedupDialog />
      <Sidebar />
      <FolderTree />
      <LibraryGrid />
      <DetailsFields />
      <DetailsFilaments />
      <DetailsNotes />
      <DetailsPath />
      <BundleDetails />
      <MultiEditPanel />
      <ManageThumbnailsDialog />
      <PreviewDialog />
      <PrintHistory />
    </>
  );
}

const root = document.getElementById('react-root');
if (root) {
  createRoot(root).render(<StrictMode><Screens /></StrictMode>);
}
