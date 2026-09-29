const input = document.getElementById('folder');
const status = document.getElementById('status');
const saveAsBox = document.getElementById('saveas');
chrome.storage.sync.get({ dlFolder: '', saveAs: false }, (r) => { input.value = r.dlFolder || ''; saveAsBox.checked = !!r.saveAs; });
document.getElementById('save').addEventListener('click', () => {
  const v = input.value.replace(/[\\/]+/g, '').trim();
  chrome.storage.sync.set({ dlFolder: v, saveAs: saveAsBox.checked }, () => {
    status.textContent = v ? `Saved — downloads go to Downloads/${v}/` : 'Saved — downloads go to Downloads/';
    setTimeout(() => status.textContent = '', 2500);
  });
});
