/**
 * background.js
 * Service Worker cho SignLang 3D Chrome Extension.
 * Hỗ trợ:
 *  - Chuyển tiếp các bản tin điều khiển giữa iframe bảng nổi trên trang web (overlay)
 *    và content script của chính tab đó (`sender.tab.id`).
 *  - Mở cửa sổ nổi độc lập (Detached Popup Window) nếu người dùng muốn tách ra khỏi trình duyệt.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPEN_DETACHED_WINDOW') {
    const targetTabId = message.tabId || sender?.tab?.id || '';
    const url = chrome.runtime.getURL(`popup.html?detached=1&tabId=${targetTabId}`);
    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: 440,
        height: 680,
        focused: true,
      },
      (win) => {
        sendResponse({ ok: true, windowId: win?.id });
      }
    );
    return true;
  }

  // Khi App chạy bên trong iframe nổi trên trang YouTube, nó có thể hỏi lấy tabId của chính nó
  if (message?.type === 'GET_MY_TAB_ID') {
    sendResponse({ tabId: sender?.tab?.id || null });
    return false;
  }

  // Cho phép iframe hoặc popup yêu cầu đóng/mở bảng nổi trên tab hiện tại
  if (message?.type === 'TOGGLE_INPAGE_PANEL' && sender?.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'TOGGLE_INPAGE_PANEL' }, sendResponse);
    return true;
  }

  return false;
});
