/* guide.js
 *
 * The Quick Start Guide (Help → Quick Start Guide; also shown once after the welcome dialog).
 * It fills the dialog <dialog id="quickstart-guide"> in index.html, one page at a time:
 * the library, model details, finding models, printing, and settings and tools.
 */

const guidePages = [
  {
    title: "Your Library",
    content: `The sidebar on the left takes you everywhere. <strong>Library</strong> shows your models as cards, with tabs for
    <strong>All Models</strong>, <strong>Printed</strong>, <strong>Unprinted</strong>, <strong>Queue</strong> and <strong>Favorites</strong>.
    <p>JusttPrint scans your <strong>STL Home</strong> folders on its own. Add or change them under <strong>Settings → Scanning → STL Home</strong>,
    and use <strong>Scan Library</strong> in the sidebar to scan right away.</p>`,
    image: "guide/guide-library.png"
  },
  {
    title: "Model Details",
    content: `Click a card to see the model on the right: a large preview (<strong>3D</strong> opens it in 3D), its tags,
    <strong>Open in Slicer</strong>, <strong>Log Print</strong>, and its details, notes and print history.
    Every field saves as you change it.
    <p>Ctrl/⌘-click or Shift-click several cards to edit them together. Right-click a card, or press the Menu key, for more actions.</p>`,
    image: "guide/guide-details.png"
  },
  {
    title: "Finding Models",
    content: `Search from the box at the top (<strong>Ctrl/⌘ K</strong>). <strong>Filter</strong> narrows the library by folder,
    designer, parent model, license, tags, print status and more; the active filters show as chips you can remove.
    <p>Switch between <strong>Grid</strong>, <strong>Wall</strong> and <strong>List</strong>, and open the folder panel to browse your folders.</p>`,
    image: "guide/guide-filter.png"
  },
  {
    title: "Printing",
    content: `<strong>Home</strong> shows your figures, recent activity and printers.
    <strong>Queue</strong> lists what is printing, what is up next and what printed lately.
    <strong>Printers</strong> keeps your printers, their web pages and maintenance reminders.
    <p>Log a print from a card's status badge or the details panel; JusttPrint keeps a dated history for each model.</p>`,
    image: "guide/guide-home.png"
  },
  {
    title: "Settings and Tools",
    content: `<strong>Tags</strong>, <strong>Duplicates</strong> and <strong>Organize</strong> help you tidy the library, and
    <strong>AI Tagging</strong> suggests tags for you. <strong>Settings</strong> has everything else in one page: theme, scanning,
    slicers, AI, server access, backups and more.
    <p><strong>Help</strong> lists the keyboard shortcuts and links to the documentation. Thank you for using JusttPrint!</p>`,
    image: "guide/guide-settings.png"
  }
];

let currentPage = 0;

// Update the guide dialog with the current page's content and image.
function updateGuide() {
  const guideText = document.getElementById("guide-text");
  const guideImage = document.getElementById("guide-image");
  const backButton = document.getElementById("guide-back-button");
  const nextButton = document.getElementById("guide-next-button");
  const progressFill = document.getElementById("guide-progress-fill");
  const progressText = document.getElementById("guide-progress-text");

  const page = guidePages[currentPage];

  // Update progress indicator
  const progress = ((currentPage + 1) / guidePages.length) * 100;
  if (progressFill) {
    progressFill.style.width = `${progress}%`;
  }
  if (progressText) {
    progressText.textContent = `Page ${currentPage + 1} of ${guidePages.length}`;
  }

  // Fade out the current content
  guideText.style.opacity = 0;
  guideImage.style.opacity = 0;

  // Set a timeout to allow the fade-out to complete before changing content
  setTimeout(() => {
    // Clear existing contents before adding new content
    guideText.innerHTML = '';

    guideText.innerHTML = `<h3>${page.title}</h3><p>${page.content}</p>`;
    if (page.image) {
      guideImage.src = page.image;
      guideImage.alt = page.title;
      guideImage.style.display = "block";
    } else {
      guideImage.style.display = "none";
    }

    // Fade in the new content
    guideText.style.opacity = 1;
    guideImage.style.opacity = 1;

    // Disable the Back button on the first page.
    backButton.disabled = currentPage === 0;

    // Update Next button text and icon
    if (currentPage === guidePages.length - 1) {
      // Last page: show "Finish" without arrow
      nextButton.innerHTML = '<span>Finish</span>';
    } else {
      // Other pages: show "Next" with arrow
      nextButton.innerHTML = '<span>Next</span><span class="guide-nav-icon">→</span>';
    }
  }, 400); // Smooth transition timing
}

// Increment the current page or close the guide if on the last page.
function nextGuide() {
  if (currentPage < guidePages.length - 1) {
    currentPage++;
    updateGuide();
  } else {
    closeGuide();
  }
}

// Decrement the current page if possible.
function prevGuide() {
  if (currentPage > 0) {
    currentPage--;
    updateGuide();
  }
}

// Opens the guide dialog starting at the first page.
function showGuide() {
  currentPage = 0;
  updateGuide();
  const guideDialog = document.getElementById("quickstart-guide");
  if (guideDialog) {
    guideDialog.showModal();
    // Add styles to ensure dialog has no black background
    guideDialog.style.backgroundColor = 'transparent';
    guideDialog.style.background = 'none';
    // Focus the dialog for keyboard navigation
    guideDialog.focus();
  } else {
    console.error('Guide dialog not found');
  }
}

// Closes the guide dialog.
function closeGuide() {
  const guideDialog = document.getElementById("quickstart-guide");
  if (guideDialog) {
    guideDialog.close();
  }
}

// Set up event listeners when the DOM content is fully loaded.
document.addEventListener("DOMContentLoaded", () => {
  const nextButton = document.getElementById("guide-next-button");
  const backButton = document.getElementById("guide-back-button");
  const closeButton = document.getElementById("guide-close-button");
  const guideDialog = document.getElementById("quickstart-guide");

  if (nextButton) {
    nextButton.addEventListener("click", nextGuide);
  }
  if (backButton) {
    backButton.addEventListener("click", prevGuide);
  }
  if (closeButton) {
    closeButton.addEventListener("click", closeGuide);
  }

  // Keyboard navigation support
  if (guideDialog) {
    guideDialog.addEventListener("keydown", (e) => {
      // Only handle keyboard events when the dialog is open
      if (!guideDialog.open) return;

      // Prevent default behavior for arrow keys
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
      }

      // Navigate with arrow keys
      if (e.key === "ArrowLeft" && currentPage > 0) {
        prevGuide();
      } else if (e.key === "ArrowRight" && currentPage < guidePages.length - 1) {
        nextGuide();
      } else if (e.key === "Escape") {
        closeGuide();
      }
    });

    // Focus management: focus the dialog when it opens
    guideDialog.addEventListener("close", () => {
      // Reset to first page when closing
      currentPage = 0;
    });
  }
  
  // After the welcome dialog is dismissed, automatically show the guide.
  const dismissWelcomeButton = document.getElementById("dismiss-welcome");
  if (dismissWelcomeButton) {
    dismissWelcomeButton.addEventListener("click", async () => {
      try {
        const hasSeenQuickStartGuide = await window.electron.getSetting("hasSeenQuickStartGuide");
        if (hasSeenQuickStartGuide) {
          return;
        }
        await window.electron.saveSetting("hasSeenQuickStartGuide", "true");
      } catch (error) {
        console.warn("Unable to read/save hasSeenQuickStartGuide setting:", error);
      }

      // Give a small delay so the welcome dialog can close.
      setTimeout(() => {
        showGuide();
      }, 500);
    });
  }
});

// Export the showGuide function so it can be called from other files
window.showGuide = showGuide; 