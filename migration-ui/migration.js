const downloadButton = document.querySelector("#download");
const status = document.querySelector("#status");

downloadButton.addEventListener("click", async () => {
  downloadButton.disabled = true;
  status.textContent = "Opening GitHub Releases…";

  try {
    await window.__TAURI__.core.invoke("open_electron_download");
    status.textContent = "The download page opened in your browser.";
  } catch (error) {
    console.error("Failed to open the Ardor download page", error);
    status.textContent = "Could not open the download page. Please try again.";
  } finally {
    downloadButton.disabled = false;
  }
});
