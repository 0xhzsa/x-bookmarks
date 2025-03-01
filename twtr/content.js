// content.js with more robust bookmark handling
// Constants
const BOOKMARK_CHECK_INTERVAL = 1000; // 1 second
const FEED_SELECTOR = '[aria-label="Timeline: Your Home Timeline"], [data-testid="primaryColumn"]';
const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const BOOKMARK_INDICATOR_CLASS = 'x-bookmark-indicator';

// Cached data
let bookmarks = [
  { id: '1234567890', userId: '1234567890', text: 'Example Bookmark 1', likes: 10, retweets: 5, created_at: '2022-01-01T12:00:00.000Z' },
  { id: '2345678901', userId: '2345678901', text: 'Example Bookmark 2', likes: 20, retweets: 10, created_at: '2022-01-02T12:00:00.000Z' }
];
let users = {
  '1234567890': { displayName: 'Example User 1', username: 'exampleuser1', profileImage: 'https://example.com/image1.jpg' },
  '2345678901': { displayName: 'Example User 2', username: 'exampleuser2', profileImage: 'https://example.com/image2.jpg' }
};
let settings = {
  enabled: true,
  showIndicator: true,
  frequency: 'medium',
  prioritizeRecent: true
};

// Mock bookmarks data for demonstration purposes
const exampleBookmarks = [
    { title: 'Example Bookmark 1', user: 'Example User 1', username: 'exampleuser1', date: 'Jan 1', url: 'https://example.com/1' },
    { title: 'Example Bookmark 2', user: 'Example User 2', username: 'exampleuser2', date: 'Jan 2', url: 'https://example.com/2' }
];

// Function to create and inject the bookmarks UI
function injectBookmarksUI() {
    console.log('Injecting bookmarks UI...'); // Debug log

    // Populate bookmarks directly without a container
    exampleBookmarks.forEach(bookmark => {
        const bookmarkItem = document.createElement('div');
        bookmarkItem.className = 'bookmark-item'; /* Ensure the correct class is applied */
        bookmarkItem.style.marginBottom = '10px';

        const link = document.createElement('a');
        link.href = bookmark.url;
        link.target = '_blank';
        link.className = 'bookmark-item'; /* Ensure the correct class is applied */
        link.style = ''; /* Clear any inline styles to prevent conflicts */
        link.innerText = `${bookmark.user} @${bookmark.username} · ${bookmark.date} ${bookmark.title.substring(0, 20)}...`; /* Limit to 20 characters */
        link.style.color = '#1DA1F2';
        link.style.textDecoration = 'none';

        bookmarkItem.appendChild(link);

        // Inject each bookmark item directly below the tweets
        const targetElement = document.querySelector('div[data-testid="tweet"]');
        if (targetElement) {
            targetElement.parentNode.insertBefore(bookmarkItem, targetElement.nextSibling);
        } else {
            console.error('Target element not found.');
        }
    });
    console.log('Bookmarks UI injected successfully.'); // Debug log
}

// Get frequency ratio based on settings
function getFrequencyRatio() {
  switch (settings.frequency) {
    case 'low': return 10; // 1 in 10 posts
    case 'high': return 3; // 1 in 3 posts
    default: return 5; // 1 in 5 posts (medium)
  }
}

// Initialize: load settings and bookmarks
function initialize() {
  console.log('Initializing X Bookmarks Feed extension');
  
  // Load settings
  chrome.storage.local.get([
    'enabled', 
    'showIndicator', 
    'frequency', 
    'prioritizeRecent'
  ], data => {
    settings = {
      enabled: data.enabled !== undefined ? data.enabled : true,
      showIndicator: data.showIndicator !== undefined ? data.showIndicator : true,
      frequency: data.frequency || 'medium',
      prioritizeRecent: data.prioritizeRecent !== undefined ? data.prioritizeRecent : true
    };
    
    console.log('Settings loaded:', settings);
    
    // Start observing the feed
    startObserver();
  });
}

// Listen for settings changes
chrome.storage.onChanged.addListener(changes => {
  console.log('Storage changes detected:', changes);
  
  if (changes.enabled) {
    settings.enabled = changes.enabled.newValue;
  }
  if (changes.showIndicator) {
    settings.showIndicator = changes.showIndicator.newValue;
    updateBookmarkIndicators();
  }
  if (changes.frequency) {
    settings.frequency = changes.frequency.newValue;
  }
  if (changes.prioritizeRecent) {
    settings.prioritizeRecent = changes.prioritizeRecent.newValue;
  }
});

// Observe DOM changes to detect new tweets being added to the feed
function startObserver() {
  console.log('Starting feed observer');
  
  // Create observer instance
  const observer = new MutationObserver(mutations => {
    if (settings.enabled && bookmarks.length > 0) {
      handleNewTweets();
    }
  });
  
  // Try to find the feed at regular intervals
  const observeInterval = setInterval(() => {
    const possibleFeeds = document.querySelectorAll(FEED_SELECTOR);
    
    if (possibleFeeds.length > 0) {
      console.log(`Found ${possibleFeeds.length} possible feed elements`);
      
      for (const feed of possibleFeeds) {
        observer.observe(feed, { childList: true, subtree: true });
      }
      
      clearInterval(observeInterval);
      console.log('Feed observer started successfully');
      
      // Process tweets already in the feed
      handleNewTweets();
    }
  }, BOOKMARK_CHECK_INTERVAL);
}

// Process tweets in the feed
function handleNewTweets() {
  if (!settings.enabled || bookmarks.length === 0) {
    return;
  }
  
  console.log('Checking for tweets to process');
  const tweetElements = document.querySelectorAll(TWEET_SELECTOR);
  console.log(`Found ${tweetElements.length} tweets in feed`);
  
  if (tweetElements.length === 0) {
    return;
  }
  
  const processedIds = new Set();
  let regularTweetCount = 0;
  
  tweetElements.forEach(tweet => {
    const tweetId = extractTweetId(tweet);
    
    // Skip if already processed or no ID found
    if (!tweetId || processedIds.has(tweetId)) {
      return;
    }
    
    processedIds.add(tweetId);
    
    // Check if this is a bookmark
    const isBookmark = bookmarks.some(b => b.id === tweetId);
    
    if (isBookmark) {
      markAsBookmark(tweet);
    } else {
      regularTweetCount++;
      
      // Check if we should insert a bookmark after this regular tweet
      const ratio = getFrequencyRatio();
      if (regularTweetCount % ratio === 0) {
        insertBookmarkAfterTweet(tweet);
      }
    }
  });
}

// Extract tweet ID from tweet element - more robust implementation
function extractTweetId(tweetElement) {
  // Method 1: From a[href^="/status/"] links
  const statusLinks = tweetElement.querySelectorAll('a[href*="/status/"]');
  for (const link of statusLinks) {
    const matches = link.href.match(/\/status\/(\d+)/);
    if (matches && matches[1]) {
      return matches[1];
    }
  }
  
  // Method 2: From time[datetime] element
  const timeElements = tweetElement.querySelectorAll('time');
  for (const time of timeElements) {
    if (time.parentElement && time.parentElement.href) {
      const matches = time.parentElement.href.match(/\/status\/(\d+)/);
      if (matches && matches[1]) {
        return matches[1];
      }
    }
  }
  
  // Method 3: From data attributes (fallback)
  const articleDataId = tweetElement.getAttribute('data-tweet-id') || 
                        tweetElement.getAttribute('data-item-id');
  if (articleDataId && articleDataId.match(/^\d+$/)) {
    return articleDataId;
  }
  
  // Method 4: Try to extract from any link with status in it
  const allLinks = tweetElement.querySelectorAll('a');
  for (const link of allLinks) {
    if (link.href) {
      const matches = link.href.match(/\/status\/(\d+)/);
      if (matches && matches[1]) {
        return matches[1];
      }
    }
  }
  
  return null;
}

// Mark a tweet as bookmarked
function markAsBookmark(tweetElement) {
  // Check if already marked
  if (tweetElement.querySelector(`.${BOOKMARK_INDICATOR_CLASS}`)) return;

  // Instead, just handle the bookmarked tweets directly
  // Your logic to show bookmarked tweets goes here
}

// Update all bookmark indicators (e.g. when setting changes)
function updateBookmarkIndicators() {
  console.log('Updating bookmark indicators');
  
  // Remove all existing indicators if they should be hidden
  if (!settings.showIndicator) {
    document.querySelectorAll(`.${BOOKMARK_INDICATOR_CLASS}`).forEach(indicator => {
      indicator.remove();
    });
    return;
  }
  
  // Otherwise re-process all tweets
  handleNewTweets();
}

// Get a random bookmark to insert
function getRandomBookmark() {
  if (bookmarks.length === 0) return null;
  
  if (settings.prioritizeRecent) {
    // Prioritize recent bookmarks (last 20%)
    const recentCount = Math.max(Math.floor(bookmarks.length * 0.2), 1);
    const startIndex = bookmarks.length - recentCount;
    const randomIndex = startIndex + Math.floor(Math.random() * recentCount);
    return bookmarks[randomIndex];
  } else {
    // Completely random selection
    const randomIndex = Math.floor(Math.random() * bookmarks.length);
    return bookmarks[randomIndex];
  }
}

// Insert a bookmarked tweet after a regular tweet
function insertBookmarkAfterTweet(tweetElement) {
  // Skip if not enabled or no parent found
  if (!settings.enabled) return;
  
  const parentContainer = tweetElement.parentElement;
  if (!parentContainer) return;
  
  // Get a random bookmark to insert
  const bookmark = getRandomBookmark();
  if (!bookmark) return;
  
  // Check if the user info exists
  const user = users[bookmark.userId];
  if (!user) {
    console.warn(`User info not found for bookmark ${bookmark.id}`);
    return;
  }
  
  // Check if this bookmark is already in the feed
  const bookmarkId = `injected-bookmark-${bookmark.id}`;
  if (document.getElementById(bookmarkId)) {
    return;
  }
  
  // Try to clone the tweet element structure
  try {
    const clonedTweet = tweetElement.cloneNode(true);
    clonedTweet.id = bookmarkId;
    clonedTweet.setAttribute('data-testid', 'injected-bookmark');
    
    // Clear inner content while keeping structure
    const contentElements = clonedTweet.querySelectorAll('div[data-testid="tweetText"], time, div[role="group"]');
    contentElements.forEach(element => {
      if (element.nodeName === 'TIME') {
        // Try to update timestamp
        element.textContent = formatDate(bookmark.created_at);
        if (element.dateTime) {
          element.dateTime = new Date(bookmark.created_at).toISOString();
        }
      } else {
        // Just clear other elements, they'll be filled later
        while (element.firstChild) {
          element.removeChild(element.firstChild);
        }
      }
    });
    
    // Update tweet text
    const tweetTextElement = clonedTweet.querySelector('div[data-testid="tweetText"]');
    if (tweetTextElement) {
      tweetTextElement.textContent = bookmark.text;
    }
    
    // Update user info (name, handle, avatar)
    const nameElement = clonedTweet.querySelector('a[role="link"] span span');
    if (nameElement) {
      nameElement.textContent = user.displayName;
    }
    
    const handleElement = clonedTweet.querySelector('a[role="link"] span:nth-child(2)');
    if (handleElement) {
      handleElement.textContent = `@${user.username}`;
    }
    
    const avatarImgs = clonedTweet.querySelectorAll('img[draggable="true"]');
    avatarImgs.forEach(img => {
      if (user.profileImage) {
        img.src = user.profileImage;
        img.srcset = '';
      }
    });
    
    // Update tweet stats (likes, retweets)
    const statsElements = clonedTweet.querySelectorAll('[data-testid="like"], [data-testid="retweet"]');
    statsElements.forEach(element => {
      const statType = element.getAttribute('data-testid');
      const statValue = statType === 'like' ? bookmark.likes : 
                        statType === 'retweet' ? bookmark.retweets : 0;
      
      const countSpan = element.querySelector('span span');
      if (countSpan) {
        countSpan.textContent = statValue;
      }
    });
    
    // Add a subtle background to distinguish from regular tweets
    clonedTweet.style.backgroundColor = 'rgba(29, 161, 242, 0.05)';
    
    // Add a small "Bookmarked" badge
    const badgeElement = document.createElement('div');
    badgeElement.className = 'bookmark-badge';
    badgeElement.textContent = 'Bookmarked';
    badgeElement.style.cssText = `
      font-size: 12px;
      color: rgb(29, 161, 242);
      font-weight: bold;
      padding: 0;
      border: none;
      background: none;
      display: inline;
      margin: 0;
    `;
    
    // Try to find a good insertion point for the badge
    const tweetBody = clonedTweet.querySelector('div[data-testid="tweetText"]');
    if (tweetBody && tweetBody.parentElement) {
      tweetBody.parentElement.appendChild(badgeElement);
    }
    
    // Insert the cloned bookmark after the regular tweet
    if (!parentContainer.contains(clonedTweet)) {
      parentContainer.insertBefore(clonedTweet, tweetElement.nextSibling);
      console.log(`Inserted bookmark ${bookmark.id} into feed`);
    }
  } catch (error) {
    console.error('Error inserting bookmark:', error);
  }
}

// Format a date string for display in tweet
function formatDate(dateString) {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMinutes < 1) {
      return 'now';
    } else if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    } else if (diffHours < 24) {
      return `${diffHours}h`;
    } else if (diffDays < 7) {
      return `${diffDays}d`;
    } else {
      // Format as "Jan 1" for older tweets
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[date.getMonth()]} ${date.getDate()}`;
    }
  } catch (e) {
    console.error('Error formatting date:', e);
    return '';
  }
}

// Add custom styles
function addCustomStyles() {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    .${BOOKMARK_INDICATOR_CLASS} {
      transition: opacity 0.2s ease;
    }
    .${BOOKMARK_INDICATOR_CLASS}:hover {
      opacity: 1;
      cursor: pointer;
    }
    #injected-bookmark-toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #1DA1F2;
      color: white;
      padding: 10px 20px;
      border-radius: 20px;
      font-weight: bold;
      z-index: 9999;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    #injected-bookmark-toast.visible {
      opacity: 1;
    }
    .bookmark-item {
      margin-bottom: 10px;
    }
  `;
  document.head.appendChild(styleElement);
}

// Show a toast message
function showToast(message, duration = 3000) {
  let toast = document.getElementById('injected-bookmark-toast');
  
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'injected-bookmark-toast';
    document.body.appendChild(toast);
  }
  
  toast.textContent = message;
  toast.classList.add('visible');
  
  setTimeout(() => {
    toast.classList.remove('visible');
  }, duration);
}

// Run the function when the DOM is fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        addCustomStyles();
        injectBookmarksUI();
        initialize();
    });
} else {
    addCustomStyles();
    injectBookmarksUI();
    initialize();
}
