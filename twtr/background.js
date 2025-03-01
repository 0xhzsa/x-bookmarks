// background.js with enhanced error handling
// Constants for X/Twitter API endpoints
const BOOKMARKS_URL = 'https://twitter.com/i/api/graphql/zZXycP0V6H7m-2r0ZW0h9A/Bookmarks';
const AUTH_TOKEN_KEY = 'x_auth_token';
const BOOKMARKS_CACHE_KEY = 'bookmarks_cache';
const USERS_CACHE_KEY = 'users_cache';

// Initialize when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed - initializing settings');
  chrome.storage.local.set({
    enabled: true,
    showIndicator: true,
    frequency: 'medium',
    prioritizeRecent: true,
    lastUpdated: null,
    bookmarkCount: 0
  });
});

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received:', message);
  
  if (message.action === 'refreshBookmarks') {
    console.log('Fetching bookmarks...');
    
    // Add delay to ensure proper response handling
    fetchBookmarks()
      .then(result => {
        console.log(`Successfully fetched ${result.length} bookmarks`);
        sendResponse({ success: true, count: result.length });
      })
      .catch(error => {
        console.error('Error fetching bookmarks:', error);
        sendResponse({ 
          success: false, 
          error: error.message,
          details: error.stack || 'No stack trace available'
        });
      });
    return true; // Required for async response
  }
  
  else if (message.action === 'getBookmarks') {
    console.log('Getting cached bookmarks');
    chrome.storage.local.get([BOOKMARKS_CACHE_KEY, USERS_CACHE_KEY], data => {
      const bookmarks = data[BOOKMARKS_CACHE_KEY] || [];
      console.log(`Retrieved ${bookmarks.length} bookmarks from cache`);
      sendResponse({
        bookmarks: bookmarks,
        users: data[USERS_CACHE_KEY] || {}
      });
    });
    return true; // Required for async response
  }
  
  else if (message.action === 'updateSettings') {
    console.log('Updating settings:', message);
    // If extension is being enabled, refresh bookmarks
    if (message.enabled) {
      fetchBookmarks()
        .then(result => console.log(`Refreshed ${result.length} bookmarks after enabling`))
        .catch(err => console.error('Error refreshing bookmarks:', err));
    }
  }
  
  else if (message.action === 'debugInfo') {
    // Return debug information
    getDebugInfo().then(info => {
      sendResponse({ success: true, debug: info });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// Function to get debug information
async function getDebugInfo() {
  try {
    const storage = await chrome.storage.local.get(null);
    const cookies = await chrome.cookies.getAll({ domain: '.twitter.com' });
    
    return {
      storage: {
        enabled: storage.enabled,
        bookmarkCount: storage.bookmarkCount,
        lastUpdated: storage.lastUpdated,
        hasAuthToken: !!storage[AUTH_TOKEN_KEY]
      },
      cookies: {
        hasAuthCookie: cookies.some(c => c.name === 'auth_token'),
        hasCSRFCookie: cookies.some(c => c.name === 'ct0'),
        cookieCount: cookies.length,
        cookieNames: cookies.map(c => c.name)
      }
    };
  } catch (err) {
    console.error('Error getting debug info:', err);
    return { error: err.message };
  }
}

// Function to extract auth token from cookies
async function getAuthToken() {
  console.log('Getting auth token from cookies...');
  const cookies = await chrome.cookies.getAll({ domain: '.twitter.com' });
  console.log(`Found ${cookies.length} Twitter cookies`);
  
  // Try multiple possible cookie names
  const authCookie = 
    cookies.find(cookie => cookie.name === 'auth_token') ||
    cookies.find(cookie => cookie.name === 'kdt') ||
    cookies.find(cookie => cookie.name === 'twid');
  
  if (!authCookie) {
    // List available cookies for debugging
    const cookieNames = cookies.map(c => c.name).join(', ');
    console.error('Auth cookie not found. Available cookies:', cookieNames);
    throw new Error('Not logged in to Twitter. Available cookies: ' + cookieNames);
  }
  
  console.log(`Found auth cookie: ${authCookie.name}`);
  return authCookie.value;
}

// Function to extract CSRF token from cookies
async function getCSRFToken() {
  console.log('Getting CSRF token from cookies...');
  const cookies = await chrome.cookies.getAll({ domain: '.twitter.com' });
  
  // Try x.com domain if twitter.com doesn't have cookies
  const xCookies = await chrome.cookies.getAll({ domain: '.x.com' });
  const allCookies = [...cookies, ...xCookies];
  
  const csrfCookie = allCookies.find(cookie => cookie.name === 'ct0');
  
  if (!csrfCookie) {
    // Check if we're on x.com instead of twitter.com
    throw new Error('CSRF token not found. Try refreshing the Twitter/X page.');
  }
  
  console.log('CSRF token found');
  return csrfCookie.value;
}

// Function to fetch bookmarks from Twitter API
async function fetchBookmarks() {
  try {
    console.log('Starting bookmark fetch process...');
    const authToken = await getAuthToken();
    const csrfToken = await getCSRFToken();
    
    // Store auth token for later use
    chrome.storage.local.set({ [AUTH_TOKEN_KEY]: authToken });
    console.log('Auth tokens retrieved and stored');
    
    // Try the new API endpoint first
    const variables = JSON.stringify({
      count: 100, // Maximum allowed by API
      includePromotedContent: false
    });
    
    const features = JSON.stringify({
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: false,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_media_download_video_enabled: false,
      responsive_web_enhance_cards_enabled: false
    });
    
    // Try multiple possible API endpoints
    const url = `${BOOKMARKS_URL}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
    
    console.log('Fetching bookmarks from API...');
    const response = await fetch(url, {
      headers: {
        'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-csrf-token': csrfToken,
        'x-twitter-auth-type': 'OAuth2Session',
        'content-type': 'application/json',
        'x-twitter-client-language': 'en',
        'x-twitter-active-user': 'yes',
        'Referer': 'https://twitter.com/i/bookmarks',
        'Origin': 'https://twitter.com'
      },
      credentials: 'include'
    });
    
    console.log('API response status:', response.status);
    if (!response.ok) {
      throw new Error(`API returned status ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('Received API response, processing data...');
    
    // Handle different possible response formats
    if (!data) {
      throw new Error('Empty response from API');
    }
    
    if (data.errors && data.errors.length > 0) {
      const errorMsg = data.errors.map(e => e.message).join('; ');
      throw new Error(`API returned errors: ${errorMsg}`);
    }
    
    // Try different possible response structures
    let bookmarksData;
    if (data.data && data.data.bookmark_timeline) {
      console.log('Using primary response structure');
      const instructions = data.data.bookmark_timeline.timeline.instructions;
      const timelineAddEntries = instructions.find(i => i.type === 'TimelineAddEntries');
      
      if (timelineAddEntries && timelineAddEntries.entries) {
        bookmarksData = timelineAddEntries.entries.filter(e => e.entryId.startsWith('tweet-'));
      } else {
        console.warn('Timeline entries not found in expected format');
        bookmarksData = [];
      }
    } else if (data.data && data.data.user && data.data.user.result && data.data.user.result.timeline) {
      console.log('Using alternative response structure');
      const timeline = data.data.user.result.timeline;
      const instructions = timeline.timeline ? timeline.timeline.instructions : timeline.instructions;
      const timelineAddEntries = instructions.find(i => i.type === 'TimelineAddEntries');
      
      if (timelineAddEntries && timelineAddEntries.entries) {
        bookmarksData = timelineAddEntries.entries.filter(e => e.entryId.startsWith('tweet-'));
      } else {
        console.warn('Timeline entries not found in alternative format');
        bookmarksData = [];
      }
    } else {
      console.log('Response structure not recognized');
      throw new Error('Unexpected API response format. Twitter may have changed their API.');
    }
    
    console.log(`Found ${bookmarksData.length} bookmarked tweets`);
    
    // Process and store bookmarks
    const bookmarks = [];
    const users = {};
    
    for (const entry of bookmarksData) {
      try {
        // Handle possible different entry structures
        let content;
        if (entry.content && entry.content.itemContent && entry.content.itemContent.tweet_results) {
          content = entry.content.itemContent.tweet_results.result;
        } else if (entry.content && entry.content.item && entry.content.item.itemContent) {
          content = entry.content.item.itemContent.tweet_results.result;
        } else {
          console.warn('Unrecognized tweet entry structure, skipping:', entry.entryId);
          continue;
        }
        
        // Check if we have a tombstone (deleted tweet)
        if (content.__typename === 'TweetTombstone') {
          console.log('Skipping tombstone tweet');
          continue;
        }
        
        // Extract tweet data
        const tweetId = content.rest_id || (content.legacy && content.legacy.id_str);
        if (!tweetId) {
          console.warn('No tweet ID found, skipping entry');
          continue;
        }
        
        // Extract user data
        let user;
        if (content.core && content.core.user_results && content.core.user_results.result) {
          user = content.core.user_results.result;
        } else if (content.user) {
          user = content.user;
        } else {
          console.warn('No user data found for tweet:', tweetId);
          continue;
        }
        
        const userId = user.rest_id || user.id_str;
        const userName = (user.legacy && user.legacy.screen_name) || user.screen_name;
        
        if (!userId || !userName) {
          console.warn('Incomplete user data for tweet:', tweetId);
          continue;
        }
        
        // Store user data
        users[userId] = {
          id: userId,
          username: userName,
          displayName: (user.legacy && user.legacy.name) || user.name || userName,
          profileImage: (user.legacy && user.legacy.profile_image_url_https) || user.profile_image_url_https || '',
          verified: !!(user.is_blue_verified || (user.legacy && user.legacy.verified))
        };
        
        // Get tweet text
        const tweetText = (content.legacy && content.legacy.full_text) || 
                         (content.tweet && content.tweet.full_text) || 
                         content.full_text || 
                         '';
        
        // Store tweet data
        bookmarks.push({
          id: tweetId,
          userId: userId,
          text: tweetText,
          created_at: (content.legacy && content.legacy.created_at) || content.created_at || new Date().toISOString(),
          bookmarked_at: Date.now(),
          media: (content.legacy && content.legacy.entities && content.legacy.entities.media) || [],
          likes: (content.legacy && content.legacy.favorite_count) || 0,
          retweets: (content.legacy && content.legacy.retweet_count) || 0,
          replies: (content.legacy && content.legacy.reply_count) || 0
        });
      } catch (err) {
        console.error('Error processing bookmark entry:', err, entry);
      }
    }
    
    console.log(`Successfully processed ${bookmarks.length} bookmarks`);
    
    // Save to local storage
    chrome.storage.local.set({
      [BOOKMARKS_CACHE_KEY]: bookmarks,
      [USERS_CACHE_KEY]: users,
      lastUpdated: Date.now(),
      bookmarkCount: bookmarks.length
    });
    
    console.log('Bookmarks saved to local storage');
    return bookmarks;
  } catch (error) {
    console.error('Error in fetchBookmarks:', error);
    throw error;
  }
}

// Function to try alternative API endpoint for bookmarks
async function fetchBookmarksAlternative(authToken, csrfToken) {
  console.log('Trying alternative bookmarks endpoint...');
  
  const altUrl = 'https://twitter.com/i/api/2/timeline/bookmark.json?count=100';
  
  const response = await fetch(altUrl, {
    headers: {
      'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      'x-csrf-token': csrfToken,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      'x-twitter-active-user': 'yes'
    },
    credentials: 'include'
  });
  
  if (!response.ok) {
    throw new Error(`Alternative API returned status ${response.status}`);
  }
  
  return response.json();
}

// Set up periodic refresh of bookmarks (every 4 hours)
chrome.alarms.create('refreshBookmarks', { periodInMinutes: 240 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshBookmarks') {
    chrome.storage.local.get('enabled', data => {
      if (data.enabled) {
        console.log('Scheduled bookmark refresh triggered');
        fetchBookmarks()
          .then(result => console.log(`Scheduled refresh complete: ${result.length} bookmarks`))
          .catch(err => console.error('Error in scheduled refresh:', err));
      }
    });
  }
});
