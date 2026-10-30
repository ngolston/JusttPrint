/**
 * The page's React screens and modules. Screens draw into slots in index.html (or into
 * document.body) and register the global functions that open them (window.openTagManager, ...).
 */
import { FilamentHubImportDialog } from './filament/FilamentHubImportDialog';
import { AlertsSettingsDialog } from './filament/AlertsSettingsDialog';
import { AiTagRunDialog } from './tags/AiTagRunDialog';
import './styles/index.css';
// First: the server connection and window.electron, which the screens use.
import './bridge/server';
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
import { DetailsNotes } from './details/DetailsNotes';
import { DetailsPath } from './details/DetailsPath';
import { FileTypeSettingsDialog } from './FileTypeSettingsDialog';
import { HttpsSettingsDialog } from './HttpsSettingsDialog';
import { GridToolbar } from './grid/GridToolbar';
import { LibraryGrid } from './grid/LibraryGrid';
import { FolderPicker } from './components/FolderPicker';
import { ListPicker } from './components/ListPicker';
import { ServerProgressDialog } from './components/ServerProgressDialog';
import { QuickStartGuide } from './QuickStartGuide';
import { initPage } from './startup/pageInit';
import { KeyboardShortcuts, KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { UndoToast } from './library/UndoToast';
import { ScanToast } from './scan/ScanToast';
import { OrganizeSettingsDialog, OrganizeToast } from './upload/Organize';
import { InstallAppDialog } from './InstallAppDialog';
import { ManageThumbnailsDialog } from './ManageThumbnailsDialog';
import { McpServerSettingsDialog } from './McpServerSettingsDialog';
import { MetadataEditorDialog } from './MetadataEditorDialog';
import { MultiEditPanel } from './details/MultiEditPanel';
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
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { UsersDialog } from './UsersDialog';
import { UploadDialog, UploadDropZone } from './upload/UploadDialog';
import { LinkImportDialog } from './links/LinkImportDialog';
import { ThingiverseSettingsDialog } from './links/ThingiverseSettingsDialog';
import { SiteFilesDownloadDialog } from './links/SiteFilesDownloadDialog';
import { MakerWorldDownloadDialog } from './makerworld/MakerWorldDownloadDialog';
import { MakerWorldSettingsDialog } from './makerworld/MakerWorldSettingsDialog';
import { EditModelDialog } from './details/EditModelDialog';
import { PhotoSearchDialog } from './search/PhotoSearchDialog';
import { AssemblyDialog } from './kits/AssemblyDialog';
import { MakerWorldSignInDialog } from './makerworld/MakerWorldSignInDialog';
import { AddToCollectionDialog } from './collections/AddToCollectionDialog';
import { ShareDialog } from './share/ShareDialog';
import { ShareLinksDialog } from './share/ShareLinksDialog';
import { SlicerSettingsDialog } from './SlicerSettingsDialog';
import { StatsDialog } from './StatsDialog';
import { StlHomeDialog } from './StlHomeDialog';
import { FirstRun } from './startup/FirstRun';
import { FolderSetup } from './startup/FolderSetup';
import { SystemReportDialog } from './SystemReportDialog';
import { TagManagerDialog } from './TagManagerDialog';
import { TagPreviewDialog } from './tags/TagPreviewDialog';
import { ThemeSettingsDialog } from './ThemeSettingsDialog';

function Screens() {
  return (
    <>
      <FirstRun />
      <ServerAccessDialog />
      <ChangePasswordDialog />
      <UsersDialog />
      <UploadDialog />
      <UploadDropZone />
      <LinkImportDialog />
      <MakerWorldDownloadDialog />
      <MakerWorldSignInDialog />
      <MakerWorldSettingsDialog />
      <EditModelDialog />
      <PhotoSearchDialog />
      <AssemblyDialog />
      <ThingiverseSettingsDialog />
      <SiteFilesDownloadDialog />
      <AddToCollectionDialog />
      <ShareDialog />
      <ShareLinksDialog />
      <TagManagerDialog />
      <TagPreviewDialog />
      <AiTagRunDialog />
      <PuterSignInDialog />
      <PartsManagerDialog />
      <PrinterManagerDialog />
      <StatsDialog />
      <SystemReportDialog />
      <BackupRestoreDialog />
      <KeyboardShortcutsDialog />
      <QuickStartGuide />
      <KeyboardShortcuts />
      <UndoToast />
      <ScanToast />
      <OrganizeToast />
      <InstallAppDialog />
      <AboutDialog />
      <PerformanceSettingsDialog />
      <McpServerSettingsDialog />
      <FileTypeSettingsDialog />
      <OrganizeSettingsDialog />
      <HttpsSettingsDialog />
      <AiConfigDialog />
      <PurgeModelsDialog />
      <ThemeSettingsDialog />
      <AlertsSettingsDialog />
      <FilamentHubImportDialog />
      <SlicerSettingsDialog />
      <MetadataEditorDialog />
      <StlHomeDialog />
      <DuplicatesOpener />
      <ContextMenu />
      <SidebarProgress />
      <ThumbnailJobDialog />
      <Sidebar />
      <FolderTree />
      <ListPicker />
      <FolderPicker />
      <FolderSetup />
      <ServerProgressDialog />
      <GridToolbar />
      <LibraryGrid />
      <DetailsFields />
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

initPage();

const root = document.getElementById('react-root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Screens />
    </StrictMode>
  );
}
