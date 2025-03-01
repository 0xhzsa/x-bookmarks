// popup.js with debugging capabilities
document.addEventListener('DOMContentLoaded', function() {
  // Get UI elements
  const extensionToggle = document.getElementById('extension-toggle');
  const indicatorToggle = document.getElementById('indicator-toggle');
  const frequencySelect = document.getElementById('frequency');
  const recentToggle = document.getElementById('recent-toggle');
  const refreshButton = document.getElementById('refresh-bookmarks');
  const lastUpdatedSpan = document.getElementById('last-updated');
  const bookmarkCountSpan = document.getElementById('bookmark-count');
  const debugButton = document.createElement('button');
  
  // Add debug button
  debugButton.textContent = 'Debug Info';
  debugButton.style.marginTop = '10px';
  debugButton.style.backgroundColor = '#888';
  document.querySelector('.container').appendChild(debugButton);
  
  // Load saved settings
  chrome.storage.local.get({
    enabled: true,
    showIndicator: true,
    frequency: 'medium',
    prioritizeRecent: true,
    lastUpdated: null,
    bookmarkCount: 0
  }, function(items) {
    extensionToggle.checked = items.enabled;
    indicatorToggle.checked = items.showIndicator;
    frequencySelect.value = items.frequency;
    recentToggle.checked = items.prioritizeRecent;
    
    if (items.lastUpdated) {
      lastUpdatedSpan.textContent = new Date(items.lastUpdated).toLocaleString();
    }
    
    bookmarkCountSpan.textContent = `${items.bookmarkCount} bookmarks loaded`;
  });
  
  // Save settings when changed
  extensionToggle.addEventListener('change', function() {
    chrome.storage.local.set({ enabled: this.checked });
    chrome.runtime.sendMessage({ action: 'updateSettings', enabled: this.checked });
  });
  
  indicatorToggle.addEventListener('change', function() {
    chrome.storage.local.set({ showIndicator: this.checked });
  });
  
  frequencySelect.addEventListener('change', function() {
    chrome.storage.local.set({ frequency: this.value });
  });
  
  recentToggle.addEventListener('change', function() {
    chrome.storage.local.set({ prioritizeRecent: this.checked });
  });
  
  // Refresh bookmarks cache when button is clicked
  refreshButton.addEventListener('click', function() {
    this.textContent = 'Refreshing...';
    this.disabled = true;
    bookmarkCountSpan.textContent = 'Fetching bookmarks...';
    
    chrome.runtime.sendMessage({ action: 'refreshBookmarks' }, function(response) {
      refreshButton.textContent = 'Refresh Bookmarks Cache';
      refreshButton.disabled = false;
      
      if (response && response.success) {
        lastUpdatedSpan.textContent = new Date().toLocaleString();
        bookmarkCountSpan.textContent = `${response.count} bookmarks loaded`;
        
        chrome.storage.local.set({ 
          lastUpdated: Date.now(),
          bookmarkCount: response.count
        });
      } else {
        const errorMsg = response && response.error ? response.error : 'Unknown error';
        bookmarkCountSpan.textContent = `Error: ${errorMsg}`;
        console.error('Refresh error:', response);
        
        // Create error details element
        const errorDetails = document.createElement('div');
        errorDetails.style.color = 'red';
        errorDetails.style.fontSize = '12px';
        errorDetails.style.marginTop = '5px';
        errorDetails.textContent = `Try opening Twitter/X in another tab and log in, then try again.`;
        
        // Replace any existing error details
        const existingDetails = document.querySelector('.error-details');
        if (existingDetails) {
          existingDetails.remove();
        }
        
        errorDetails.className = 'error-details';
        bookmarkCountSpan.parentNode.insertBefore(errorDetails, bookmarkCountSpan.nextSibling);
      }
    });
  });
  
  // Debug button handler
  debugButton.addEventListener('click', function() {
    this.textContent = 'Loading...';
    this.disabled = true;
    
    chrome.runtime.sendMessage({ action: 'debugInfo' }, function(response) {
      debugButton.textContent = 'Debug Info';
      debugButton.disabled = false;
      
      if (response && response.success) {
        const debugInfo = response.debug;
        const debugDetails = document.createElement('div');
        debugDetails.className = 'debug-details';
        debugDetails.style.marginTop = '10px';
        debugDetails.style.padding = '10px';
        debugDetails.style.backgroundColor = '#f5f5f5';
        debugDetails.style.borderRadius = '4px';
        debugDetails.style.fontSize = '12px';
        debugDetails.style.fontFamily = 'monospace';
        debugDetails.style.whiteSpace = 'pre-wrap';
        
        // Create debug info text
        let debugText = '--- DEBUG INFO ---\n';
        debugText += `Extension enabled: ${debugInfo.storage.enabled}\n`;
        debugText += `Bookmark count: ${debugInfo.storage.bookmarkCount}\n`;
        debugText += `Last updated: ${debugInfo.storage.lastUpdated ? new Date(debugInfo.storage.lastUpdated).toLocaleString() : 'never'}\n`;
        debugText += `Has auth token: ${debugInfo.storage.hasAuthToken}\n\n`;
        debugText += `Has auth cookie: ${debugInfo.cookies.hasAuthCookie}\n`;
        debugText += `Has CSRF cookie: ${debugInfo.cookies.hasCSRFCookie}\n`;
        debugText += `Cookie count: ${debugInfo.cookies.cookieCount}\n`;
        debugText += `Cookie names: ${debugInfo.cookies.cookieNames.join(', ')}\n`;
        
        debugDetails.textContent = debugText;
        
        // Replace existing debug info or add new one
        const existingDebug = document.querySelector('.debug-details');
        if (existingDebug) {
          existingDebug.replaceWith(debugDetails);
        } else {
          document.querySelector('.container').appendChild(debugDetails);
        }
      } else {
        const errorMsg = response && response.error ? response.error : 'Unknown error';
        alert(`Error getting debug info: ${errorMsg}`);
      }
    });
  });
});
