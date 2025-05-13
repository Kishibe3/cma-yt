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
                        access_token = await new Promise(resolve => {
                            chrome.runtime.sendMessage({
                                origin: 'cmayt-background.js',
                                action: 'request token'
                            }, resolve);
                        });
                        if (access_token)
                            access_token = access_token.token;
                    }
                    resp = await video_comment(request.video_id);
                    if (resp) {
                        let alluser = await concurency_limiter(resp.user, async k => [k, await user(k)], 500);
                        resp.user = Object.fromEntries(alluser);
                    }
                }
                while (!resp);
                sendResponse(resp);
            })();
        }
        else if (request.action === 'detect simplified chinese' && request.words.length > 0) {
            // 限制一次只能翻譯1800字以內
            async function translate(txt) {
                function determine_lang(arr) {
                    let last = arr.at(-1), count = {};
                    arr.slice(0, -1).forEach(s => count[s] = (count[s] || 0) + 1);
                    let max = Math.max(...Object.values(count));
                    let candidates = Object.keys(count).filter(s => count[s] === max);
                    return candidates.length === 0 ? last :
                        candidates.length === 1 ? candidates[0] :
                        candidates.includes(last) ? last :
                        candidates[Math.floor(Math.random() * candidates.length)];
                }
                let chunks = [];
                for (let i = 0; i < txt.length; i += 1800)
                    chunks.push(txt.slice(i, Math.min(i + 1800, txt.length)));
                let trans = await Promise.all(chunks.map(e => 
                    fetch('https://clients5.google.com/translate_a/single?dj=1&dt=t&dt=sp&dt=ld&dt=bd&client=dict-chrome-ex&sl=auto&tl=zh-TW&q=' + e)
                        .then(el => el.json()).then(el => {return {
                            src: el['src'],
                            trans: el['sentences'][0]['trans']
                        };})
                ));
                return {
                    src: determine_lang(trans.map(e => e.src)),
                    trans: trans.map(e => e.trans).join('')
                };
            }
            (async () => {
                let resp = await Promise.all(request.words.map(e => translate(e)));
                sendResponse({
                    words: resp
                });
            })();
        }
        else if (request.action === 'scan most view videos') {
            (async () => {
                let videos = await most_view_videos('view');
                sendResponse({
                    videos: videos
                });
            })();
        }
        else if (request.action === 'scan most comments videos') {
            (async () => {
                let videos = await most_view_videos('comment');
                sendResponse({
                    videos: videos
                });
            })();
        }
            
        return true;
    }
});

// 從playboard.co的api取得過去30天内台灣每日最多觀看或評論的政治與新聞影片前100名
async function most_popular_videos(type = 'view') {
    if (type === 'comment')
        cat = 23;
    else
        cat = 20;
    async function get_video_id(day) {
        let video_ids = [], cursor = '';
        while (true) {
            try {
                let js = await fetch(`https://lapi.playboard.co/v1/chart/video?locale=en&countryCode=TW&period=${day}&size=25&chartTypeId=20&periodTypeId=2&indexDimensionId=${cat}&indexTypeId=4&indexTarget=25&indexCountryCode=TW&cursor=${cursor}`)
                    .then(e => e.json());
                cursor = js['cursor'];
                video_ids.push(...js['list'].map(e => e.itemId));
            }
            catch (e) {
                break;
            }
        }
        await new Promise(e => setTimeout(e, 60000));
        return video_ids;
    }
    let td = new Date();
    return Array.from(new Set((await concurency_limiter(Array.from({ length: 30 }, (_, i) => i + 1).map(e => Date.UTC(td.getUTCFullYear(), td.getUTCMonth(), td.getUTCDate() - e) / 1000), get_video_id, 3)).flat()));
}

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
        if ('error' in resp.token) {
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
    let alluser = Array.from(new Set([
		...comments.map(e => e['snippet']['topLevelComment']['snippet']['authorChannelId']['value']),
		...replies.filter(e => e !== null).map(e => e.map(el => el.userid)).flat()
	]));
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
    return {
        user: alluser,
        comment: comments
    };
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