let videos = {};

document.querySelector('#btn').addEventListener('click', function () {
    const v = document.querySelector('#video_id').value;
    if (!v) return;

    chrome.runtime.sendMessage({
        video_id: v,
        action: 'get video comments'
    }, function (resp) {
        if (chrome.runtime.lastError)
            console.error(chrome.runtime.lastError);
        else
            videos[v] = resp;
    });
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;
    if (request.origin === 'cmayt-background.js' && request.action === 'request token') {
        const token = prompt('Please enter a new access token.');
        sendResponse({ token });
    }
});

// 下載json檔案
function djs(obj, filename = 'object.json') {
    if (typeof document !== 'undefined') {
        let a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 4)], { type: "application/json" }));
        a.href = url;
        a.download = filename + (filename.endsWith('.json')? '' : '.json');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// 去除回覆留言中附帶的custom url，無法保證去除完全，因為可能被回覆的人已經刪留言了、找不到
function rip_custom_url(video) {
    if (!('user' in video && 'comment' in video)) return;
    let user = structuredClone(video['user']), comment = structuredClone(video['comment']);
    for (let cmt of comment) {
        if (!('replies' in cmt)) continue;
        let reg = [user[cmt.userid].userurl];
        for (let rep of cmt['replies']) {
            rep.text = rep.text.replace(new RegExp(reg.join('|'), 'gi'), '');
            if (!reg.includes(user[rep.userid].userurl))
                reg.push(user[rep.userid].userurl);
        }
    }
    return {
        user: user,
        comment: comment
    };
}

// 將一部影片下原本結構化的留言轉換成以留言者為索引的格式
function flaten(video) {
    if (!('user' in video && 'comment' in video)) return;
    let user = structuredClone(video['user']), comment = structuredClone(video['comment']);
    comment = comment.map(e => {
        const { replies, ...rest } = e;
        return rest;
    }).concat(comment.filter(e => 'replies' in e).map(e => e['replies']).flat());
    for (let cmt of comment) {
        const { userid, ...rest } = cmt;
        if (!('comments' in user[userid]))
            user[userid]['comments'] = [];
        user[userid]['comments'].push(rest);
    }
    return user;
}

// 讓Google字典翻譯成繁體中文，抓出可能是簡體的部份
function find_simplified_chinese(txts) {
    txts = txts.map(e => e.replace(/[^\u4e00-\u9fff]/g, ''));
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            words: txts,
            action: 'detect simplified chinese'
        }, function (resp) {
            if (chrome.runtime.lastError)
                reject(chrome.runtime.lastError);
            else
                resolve(txts.map((v, i) => v !== resp.words[i]? v : null).filter(e => e !== null));
        });
    });
}

// 過多Promise同時請求會耗盡網路資源，需要分批請求
async function concurency_limiter(tasks, promise_builder, batch = 70) {
    // 將tasks中的元素餵給promise_builder就會建立一個Promise
    let retn = [];
    for (let i = 0; i < tasks.length; i += batch)
        retn.push(...(await Promise.all(tasks.slice(i, Math.min(i + batch, tasks.length)).map(e => promise_builder(e)))));
    return retn;
}

// 對一部影片的所有留言者檢查他們的留言與帳號簡介是否有簡體中文，不檢查帳號名與自訂url因為字數太短讓Google翻譯容易誤判
async function detect_suspicious_user(video) {
    if (!('user' in video && 'comment' in video)) return;
    let user = flaten(rip_custom_url(video));
    for (let [k, v] of Object.entries(user).sort((a, b) => b[1].comments.length - a[1].comments.length))
        user[k].comments = await find_simplified_chinese([v.detail, ...v.comments.map(e => e.text)]);
    return user;
}


/*
let usercmt = await detect_suspicious_user(videos['XVfaDA8qaFU']);
// 簡體字
Object.entries(usercmt).sort((a, b) => b[1].comments.length - a[1].comments.length).filter(e => e[1].comments.length > 0);
// 非簡體字
Object.entries(flaten(videos['XVfaDA8qaFU'])).filter(([_, v]) => usercmt[v.userid].comments.length === 0).sort((a, b) => b[1].comments.length - a[1].comments.length)
*/