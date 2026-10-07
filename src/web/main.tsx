/**
 * The page's React screens and modules. Screens draw into slots in index.html (or into
 * document.body) and register the global functions that open them (window.openTagManager, ...).
 */
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AboutDialog } from './AboutDialog';
import { AiConfigDialog } from './AiConfigDialog';
import { BackupRestoreDialog } from './BackupRestoreDialog';
import { DuplicatesOpener } from './pages/DuplicatesPage';
import { DesignGallery } from './design/Gallery';
import { AppShell } from './shell/AppShell';
import { BundleDetails } from './details/BundleDetails';
import { DetailsFields } from './details/DetailsFields';
import { DetailsFilaments } from './details/DetailsFilaments';
import { DetailsNotes } from './details/DetailsNotes';
import { DetailsPath } from './details/DetailsPath';
import { FileTypeSettingsDialog } from './FileTypeSettingsDialog';
import { HttpsSettingsDialog } from './HttpsSettingsDialog';
import { GridToolbar } from './grid/GridToolbar';
import { LibraryGrid } from './grid/LibraryGrid';
import { AddFilamentDialog } from './components/AddFilamentDialog';
import { FolderPicker } from './components/FolderPicker';
import { ListPicker } from './components/ListPicker';
import { ServerProgressDialog } from './components/ServerProgressDialog';
import { KeyboardShortcuts, KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { ManageThumbnailsDialog } from './ManageThumbnailsDialog';
import { McpServerSettingsDialog } from './McpServerSettingsDialog';
import { MetadataEditorDialog } from './MetadataEditorDialog';
import { MultiEditPanel } from './details/MultiEditPanel';
import { OrganizeLibraryOpener } from './pages/OrganizePage';
import { PartsManagerDialog } from './PartsManagerDialog';
import { PerformanceSettingsDialog } from './PerformanceSettingsDialog';
import { PrinterManagerDialog } from './PrinterManagerDialog';
import './preview/files';
import './thumbnails';
import './parse';
import './filters/search';
import './library/hosts';
import './library/actions';
import './ai/puter';
import './startup/start';
import { Sidebar } from './filters/Sidebar';
import { SidebarProgress, ThumbnailJobDialog } from './scan/Progress';
import { FolderTree } from './folders/FolderTree';
import { ContextMenu } from './menus/ContextMenu';
import { PreviewDialog } from './preview/PreviewDialog';
import { PrintHistory } from './print/PrintHistory';
import { PurgeModelsDialog } from './PurgeModelsDialog';
import { PuterSignInDialog } from './ai/PuterSignInDialog';
import { ServerAccessDialog } from './ServerAccessDialog';
import { SlicerSettingsDialog } from './SlicerSettingsDialog';
import { StatsDialog } from './StatsDialog';
import { StlHomeDialog } from './StlHomeDialog';
import { FirstRun } from './startup/FirstRun';
import { SystemReportDialog } from './SystemReportDialog';
import { TagManagerDialog } from './TagManagerDialog';
import { TagPreviewDialog } from './tags/TagPreviewDialog';
import { ThemeSettingsDialog } from './ThemeSettingsDialog';

function Screens() {
  return (
    <>
      <FirstRun />
      <ServerAccessDialog />
      <TagManagerDialog />
      <TagPreviewDialog />
      <PuterSignInDialog />
      <PartsManagerDialog />
      <AddFilamentDialog />
      <PrinterManagerDialog />
      <StatsDialog />
      <SystemReportDialog />
      <BackupRestoreDialog />
      <KeyboardShortcutsDialog />
      <KeyboardShortcuts />
      <AboutDialog />
      <PerformanceSettingsDialog />
      <McpServerSettingsDialog />
      <FileTypeSettingsDialog />
      <HttpsSettingsDialog />
      <AiConfigDialog />
      <PurgeModelsDialog />
      <ThemeSettingsDialog />
      <SlicerSettingsDialog />
      <MetadataEditorDialog />
      <StlHomeDialog />
      <OrganizeLibraryOpener />
      <DuplicatesOpener />
      <ContextMenu />
      <SidebarProgress />
      <ThumbnailJobDialog />
      <Sidebar />
      <FolderTree />
      <ListPicker />
      <FolderPicker />
      <ServerProgressDialog />
      <GridToolbar />
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
      <AppShell />
      <DesignGallery />
    </>
  );
}

const root = document.getElementById('react-root');
if (root) {
  createRoot(root).render(<StrictMode><Screens /></StrictMode>);
}
