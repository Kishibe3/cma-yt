let access_token = '';

chrome.action.onClicked.addListener(function () {
    chrome.tabs.create({
        url: chrome.runtime.getURL('analyzer.html')
    });
});

// 過多Promise同時請求會耗盡網路資源，需要分批請求
async function concurency_limiter(tasks, promise_builder, batch = 70) {
    // 將tasks中的元素餵給promise_builder就會建立一個Promise
    let retn = [];
    for (let i = 0; i < tasks.length; i += batch)
        retn.push(...(await Promise.all(tasks.slice(i, Math.min(i + batch, tasks.length)).map(e => promise_builder(e)))));
    return retn;
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;
    if (sender.url.includes('analyzer.html')) {
        if (request.action === 'get video comments' && request.video_id !== '') {
            (async () => {
                let resp = undefined;
                do {
                    if (access_token === '') {
                        access_token = (await new Promise(resolve => {
                            chrome.runtime.sendMessage({
                                origin: 'cmayt-background.js',
                                action: 'request token'
                            }, resolve);
                        })).token;
                    }
                    resp = await video_comment(request.video_id);
                }
                while (!resp);
                sendResponse({
                    user: resp.alluser,
                    comment: resp.comments
                });
            })();
        }
        else if (request.action === 'detect simplified chinese' && request.words.length > 0) {
            async function translate(txt) {
                let chunks = [];
                for (let i = 0; i < txt.length; i += 1800)
                    chunks.push(txt.slice(i, Math.min(i + 1800, txt.length)));
                return (await Promise.all(chunks.map(e => 
                    fetch('https://clients5.google.com/translate_a/single?dj=1&dt=t&dt=sp&dt=ld&dt=bd&client=dict-chrome-ex&sl=auto&tl=zh-TW&q=' + e)
                        .then(el => el.json()).then(el => el['sentences'][0]['trans'])
                ))).join('');
            }
            (async () => {
                let resp = await Promise.all(request.words.map(e => translate(e)));
                sendResponse({
                    words: resp
                });
            })();
        }
            
        return true;
    }
});

async function video_comment(video_id) {
    let comments = [], resp = {}, page_token = '';
    do {
        resp = await fetch(`https://content-youtube.googleapis.com/youtube/v3/commentThreads?part=id,snippet,replies&maxResults=100&videoId=${video_id}` + (page_token !== '' ? `&pageToken=${page_token}` : ''), {
            'method': 'GET',
            'headers': {
                'Authorization': `Bearer ${access_token}`,
                'Accept': 'application/json'
            }
        });
        resp = await resp.json();
        if ('error' in resp && resp['error']['code'] == 401) {
            console.log(resp['error']['message']);
            access_token = '';
            return;
        }
        if ('items' in resp)
            comments.push(...resp['items']);
        if ('nextPageToken' in resp)
            page_token = resp['nextPageToken'];
    }
    while ('nextPageToken' in resp);
    // 去除重複id的留言，例如釘選留言
    comments = Array.from(new Map(comments.map(e => [e.id, e])).values());

    let replies = await Promise.all(comments.map(e => {
        if ('replies' in e)
            return comment_reply(e['id']);
        else
            return Promise.resolve(null);
    }));
    let alluser = new Set([
		...comments.map(e => e['snippet']['topLevelComment']['snippet']['authorChannelId']['value']),
		...replies.filter(e => e !== null).map(e => e.map(el => el.userid)).flat()
	]);
    alluser = await concurency_limiter(Array.from(alluser), async k => [k, await user(k)], 500);
	alluser = Object.fromEntries(alluser);
    comments = comments.map((e, i) => {
        delete e['etag'];
        delete e['kind'];
        if ('replies' in e)
            e['replies'] = replies[i];
        e['userid'] = e['snippet']['topLevelComment']['snippet']['authorChannelId']['value'];
        e['text'] = e['snippet']['topLevelComment']['snippet']['textOriginal'];
        e['timepublish'] = e['snippet']['topLevelComment']['snippet']['publishedAt'];
        e['timeupdate'] = e['snippet']['topLevelComment']['snippet']['updatedAt'];
        e['like'] = e['snippet']['topLevelComment']['snippet']['likeCount'];
        delete e['snippet'];
        return e;
    });
    return { alluser, comments };
}

async function comment_reply(comment_id) {
    let replies = [], resp = {}, page_token = '';
    do {
        resp = await fetch(`https://content-youtube.googleapis.com/youtube/v3/comments?part=id,snippet&maxResults=100&parentId=${comment_id}` + (page_token !== '' ? `&pageToken=${page_token}` : ''), {
            'method': 'GET',
            'headers': {
                'Authorization': `Bearer ${access_token}`,
                'Accept': 'application/json'
            }
        });
        resp = await resp.json();
        if ('error' in resp && resp['error']['code'] == 401) {
            console.log(resp['error']['message']);
            access_token = '';
            return;
        }
        if ('items' in resp)
            replies.push(...resp['items']);
        if ('nextPageToken' in resp)
            page_token = resp['nextPageToken'];
    }
    while ('nextPageToken' in resp);
    return replies.map(e => {
        delete e['etag'];
        delete e['kind'];
        e['userid'] = e['snippet']['authorChannelId']['value'];
        e['text'] = e['snippet']['textOriginal'];
        e['timepublish'] = e['snippet']['publishedAt'];
        e['timeupdate'] = e['snippet']['updatedAt'];
        e['like'] = e['snippet']['likeCount'];
        delete e['snippet'];
        return e;
    });
}

async function user(user_id) {
    let e = await fetch(`https://content-youtube.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${user_id}`, {
        'method': 'GET',
        'headers': {
            'Authorization': `Bearer ${access_token}`,
            'Accept': 'application/json'
        }
    });
    e = await e.json();
    if ('error' in e && e['error']['code'] == 401) {
        console.log(e['error']['message']);
        access_token = '';
        return;
    }
    e = e['items'][0];
    let resp = {};
    resp['userid'] = e['id'];
    resp['username'] = e['snippet']['title'];
    resp['userurl'] = e['snippet']['customUrl'];
    resp['userimage'] = e['snippet']['thumbnails']['high']['url'];
    resp['detail'] = e['snippet']['description'];
    resp['timepublish'] = e['snippet']['publishedAt'];
    resp['country'] = e['snippet']['country'];
    resp['view'] = Number(e['statistics']['viewCount']);
    resp['subscribers'] = Number(e['statistics']['subscriberCount']);
    resp['videos'] = Number(e['statistics']['videoCount']);
    return resp
}