' Aurora for Roku: sign in, Movies, TV Shows and Live TV. Talks to the same Emby server (and the same Live TV settings) as the
' phone, TV and website apps.

sub init()
    m.defaultServer = "https://emby4836.duckdns.org:8920"
    m.reg = CreateObject("roRegistrySection", "aurora")
    m.deviceId = CreateObject("roDeviceInfo").GetChannelClientId()
    m.tasks = []          ' running requests are kept here so they are not dropped before they answer

    m.signin = m.top.findNode("signin")
    m.app = m.top.findNode("app")
    m.menu = m.top.findNode("menu")
    m.list2 = m.top.findNode("list2")
    m.grid = m.top.findNode("grid")
    m.status = m.top.findNode("status")
    m.video = m.top.findNode("video")
    m.banner = m.top.findNode("banner")
    m.btnUser = m.top.findNode("btnUser")
    m.btnPass = m.top.findNode("btnPass")
    m.btnSignIn = m.top.findNode("btnSignIn")
    m.siMsg = m.top.findNode("siMsg")

    m.mode = ""           ' movies, shows or live
    m.username = ""
    m.password = ""
    m.live = invalid      ' the Live TV settings
    m.m3uGroups = {}
    m.channels = []       ' the channels on screen (Live TV)
    m.channelIndex = 0
    m.episodes = []
    m.session = invalid   ' what is playing, for telling the server
    m.hideTimer = invalid

    ' menu
    menuContent = CreateObject("roSGNode", "ContentNode")
    for each name in ["Movies", "TV Shows", "Live TV", "Sign out"]
        c = menuContent.CreateChild("ContentNode")
        c.title = name
    end for
    m.menu.content = menuContent

    m.menu.observeField("itemSelected", "onMenu")
    m.list2.observeField("itemSelected", "onList2")
    m.grid.observeField("itemSelected", "onGrid")
    m.btnUser.observeField("buttonSelected", "onUserButton")
    m.btnPass.observeField("buttonSelected", "onPassButton")
    m.btnSignIn.observeField("buttonSelected", "onSignInButton")
    m.video.observeField("state", "onVideoState")

    if getSetting("token") <> "" and getSetting("userId") <> ""
        showApp()
    else
        showSignIn()
    end if
end sub

' ----- Settings (kept on the Roku) -----

function getSetting(key as string) as string
    if m.reg.Exists(key) then return m.reg.Read(key)
    return ""
end function

sub setSetting(key as string, value as string)
    m.reg.Write(key, value)
    m.reg.Flush()
end sub

function server() as string
    addr = getSetting("server")
    if addr = "" then addr = m.defaultServer
    return addr
end function

' ----- Helpers -----

' A value as text, whatever the server sent it as (a number or a string).
function s(v as dynamic) as string
    if v = invalid then return ""
    t = type(v)
    if t = "roString" or t = "String" then return v
    if t = "roInt" or t = "roInteger" or t = "Integer" or t = "roFloat" or t = "Float" or t = "roDouble" or t = "Double" or t = "LongInteger" then return Str(v).Trim()
    return ""
end function

function authHeader(withToken as boolean) as string
    h = "MediaBrowser Client=" + Chr(34) + "Aurora" + Chr(34) + ", Device=" + Chr(34) + "Roku" + Chr(34) + ", DeviceId=" + Chr(34) + m.deviceId + Chr(34) + ", Version=" + Chr(34) + "2.0.0" + Chr(34)
    if withToken then h = h + ", Token=" + Chr(34) + getSetting("token") + Chr(34)
    return h
end function

function embyHeaders() as object
    return { "X-Emby-Authorization": authHeader(true), "X-Emby-Token": getSetting("token") }
end function

' Starts one web request. ctx says what to do with the answer (see onApi).
sub request(url as string, ctx as object, headers = {} as object, method = "GET" as string, body = "" as string)
    task = CreateObject("roSGNode", "ApiTask")
    task.url = url
    task.method = method
    task.headers = headers
    task.body = body
    task.ctx = ctx
    task.observeField("result", "onApi")
    m.tasks.Push(task)
    task.control = "RUN"
end sub

sub emby(path as string, ctx as object, method = "GET" as string, body = "" as string)
    request(server() + "/emby" + path, ctx, embyHeaders(), method, body)
end sub

sub setStatus(text as string)
    m.status.text = text
end sub

' ----- Sign in -----

sub showSignIn()
    m.app.visible = false
    m.signin.visible = true
    m.siMsg.text = ""
    m.btnUser.text = "Username"
    m.btnPass.text = "Password"
    m.username = ""
    m.password = ""
    m.btnUser.setFocus(true)
end sub

sub onUserButton()
    askText("Username", m.username, false, "gotUser")
end sub

sub onPassButton()
    askText("Password", m.password, true, "gotPass")
end sub

sub askText(title as string, value as string, secret as boolean, doneName as string)
    d = CreateObject("roSGNode", "StandardKeyboardDialog")
    d.title = title
    d.text = value
    d.buttons = ["OK", "Cancel"]
    if secret then d.textEditBox.secureMode = true
    m.askDone = doneName
    d.observeField("buttonSelected", "onAskButton")
    m.top.dialog = d
end sub

sub onAskButton(event as object)
    d = event.getRoSGNode()
    if event.getData() = 0
        if m.askDone = "gotUser"
            m.username = d.text.Trim()
            m.btnUser.text = "Username: " + m.username
        else
            m.password = d.text
            m.btnPass.text = "Password: " + String(Len(m.password), "*")
        end if
    end if
    d.close = true
    m.btnSignIn.setFocus(true)
end sub

sub onSignInButton()
    if m.username = ""
        m.siMsg.text = "Type your username first."
        return
    end if
    m.siMsg.text = "Signing in..."
    body = FormatJson({ Username: m.username, Pw: m.password })
    request(server() + "/emby/Users/AuthenticateByName", { kind: "auth" }, { "X-Emby-Authorization": authHeader(false) }, "POST", body)
end sub

sub showApp()
    m.signin.visible = false
    m.app.visible = true
    m.live = invalid
    layoutFor("movies")
    m.menu.setFocus(true)
    m.menu.jumpToItem = 0
    loadMovies()
end sub

' ----- Screens -----

' Where things sit: Movies and TV Shows use the whole width; Live TV has its categories in a column; episodes cover the grid.
sub layoutFor(mode as string)
    m.mode = mode
    m.list2.visible = false
    m.grid.visible = true
    m.status.text = ""
    if mode = "live"
        m.grid.translation = [660, 90]
        m.grid.numColumns = 3
        m.grid.basePosterSize = [170, 130]
        m.list2.translation = [300, 100]
        m.list2.itemSize = [340, 50]
        m.list2.visible = true
    else
        m.grid.translation = [300, 90]
        m.grid.numColumns = 5
        m.grid.basePosterSize = [170, 255]
    end if
end sub

sub onMenu(event as object)
    index = event.getData()
    if index = 0
        loadMovies()
    else if index = 1
        loadShows()
    else if index = 2
        loadLive()
    else
        signOut()
    end if
end sub

sub signOut()
    setSetting("token", "")
    setSetting("userId", "")
    showSignIn()
end sub

function posterUrl(id as string, height as integer) as string
    return server() + "/emby/Items/" + id + "/Images/Primary?maxHeight=" + height.toStr() + "&quality=85&api_key=" + getSetting("token")
end function

sub loadMovies()
    layoutFor("movies")
    setStatus("Loading...")
    m.grid.content = invalid
    emby("/Users/" + getSetting("userId") + "/Items?IncludeItemTypes=Movie&Recursive=true&SortBy=SortName&Limit=300&Fields=ProductionYear", { kind: "items", itemKind: "Movie" })
end sub

sub loadShows()
    layoutFor("shows")
    setStatus("Loading...")
    m.grid.content = invalid
    emby("/Users/" + getSetting("userId") + "/Items?IncludeItemTypes=Series&Recursive=true&SortBy=SortName&Limit=300&Fields=ProductionYear", { kind: "items", itemKind: "Series" })
end sub

' ----- Answers from the network -----

sub onApi(event as object)
    task = event.getRoSGNode()
    r = event.getData()
    ctx = task.ctx
    for i = 0 to m.tasks.Count() - 1
        if m.tasks[i].isSameNode(task)
            m.tasks.Delete(i)
            exit for
        end if
    end for
    kind = ctx.kind
    if kind = "auth"
        gotAuth(r)
    else if kind = "items"
        gotItems(r, ctx)
    else if kind = "episodes"
        gotEpisodes(r)
    else if kind = "playinfo"
        gotPlayInfo(r, ctx)
    else if kind = "liveprefs"
        gotLivePrefs(r)
    else if kind = "xcats"
        gotXtreamCats(r)
    else if kind = "xstreams"
        gotXtreamStreams(r, ctx)
    else if kind = "m3u"
        gotM3u(r)
    end if
end sub

sub gotAuth(r as object)
    json = invalid
    if r.status = 200 then json = ParseJson(r.body)
    if json = invalid or json.AccessToken = invalid or json.User = invalid
        if r.status = 401 or r.status = 400 or r.status = 403
            m.siMsg.text = "That username or password isn't right."
        else if r.status = 0
            m.siMsg.text = "Couldn't reach the server. Check your internet and try again."
        else
            m.siMsg.text = "The server answered " + r.status.toStr() + "."
        end if
        return
    end if
    setSetting("token", json.AccessToken)
    setSetting("userId", json.User.Id)
    m.password = ""
    showApp()
end sub

sub gotItems(r as object, ctx as object)
    json = invalid
    if r.status = 200 then json = ParseJson(r.body)
    if json = invalid or json.Items = invalid
        if r.status = 401
            signOut()
        else
            setStatus("Couldn't load the list. Check your connection and try again.")
        end if
        return
    end if
    if ctx.itemKind = "Movie" and m.mode <> "movies" then return
    if ctx.itemKind = "Series" and m.mode <> "shows" then return
    root = CreateObject("roSGNode", "ContentNode")
    for each it in json.Items
        c = root.CreateChild("ContentNode")
        c.title = it.Name
        c.shortdescriptionline1 = it.Name
        c.hdgridposterurl = posterUrl(it.Id, 450)
        c.id = it.Id
        c.description = ctx.itemKind
    end for
    m.grid.content = root
    if json.Items.Count() = 0 then setStatus("Nothing here yet.") else setStatus("")
end sub

sub onGrid(event as object)
    index = event.getData()
    c = m.grid.content.getChild(index)
    if c = invalid then return
    if m.mode = "movies"
        playItem(c.id, c.title)
    else if m.mode = "shows"
        m.showTitle = c.title
        setStatus("")
        emby("/Shows/" + c.id + "/Episodes?UserId=" + getSetting("userId") + "&Fields=Overview", { kind: "episodes" })
    else if m.mode = "live"
        m.channelIndex = index
        playChannel(index)
    end if
end sub

' ----- Episodes -----

sub gotEpisodes(r as object)
    json = invalid
    if r.status = 200 then json = ParseJson(r.body)
    if json = invalid or json.Items = invalid or json.Items.Count() = 0
        setStatus("There are no episodes to show.")
        return
    end if
    m.episodes = json.Items
    root = CreateObject("roSGNode", "ContentNode")
    for each ep in json.Items
        c = root.CreateChild("ContentNode")
        label = ""
        if ep.ParentIndexNumber <> invalid then label = "S" + s(ep.ParentIndexNumber) + " "
        if ep.IndexNumber <> invalid then label = label + "E" + s(ep.IndexNumber) + "  "
        c.title = label + ep.Name
        c.id = ep.Id
    end for
    m.list2.itemSize = [940, 50]
    m.list2.translation = [300, 100]
    m.list2.content = root
    m.list2.visible = true
    m.grid.visible = false
    m.mode = "episodes"
    m.list2.setFocus(true)
end sub

sub onList2(event as object)
    index = event.getData()
    c = m.list2.content.getChild(index)
    if c = invalid then return
    if m.mode = "episodes"
        playItem(c.id, c.title)
    else if m.mode = "live"
        loadChannels(c.id)
    end if
end sub

' ----- Playing a movie or episode -----

' What a Roku plays as it is; the server converts everything else to HLS.
function deviceProfile() as object
    return {
        Name: "Aurora Roku",
        MaxStreamingBitrate: 20000000,
        MaxStaticBitrate: 20000000,
        DirectPlayProfiles: [{ Container: "mp4,m4v,mkv", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3,eac3,mp3" }],
        TranscodingProfiles: [{ Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3", Protocol: "hls", Context: "Streaming", MaxAudioChannels: "6", MinSegments: "1", BreakOnNonKeyFrames: true }],
        CodecProfiles: [{ Type: "Video", Codec: "h264", Conditions: [{ Condition: "LessThanEqual", Property: "VideoLevel", Value: "41", IsRequired: false }] }],
        SubtitleProfiles: [{ Format: "srt", Method: "Encode" }, { Format: "ass", Method: "Encode" }, { Format: "ssa", Method: "Encode" }, { Format: "pgssub", Method: "Encode" }, { Format: "vtt", Method: "Encode" }]
    }
end function

sub playItem(id as string, title as string)
    setStatus("Starting " + title + "...")
    m.pendingTitle = title
    path = "/Items/" + id + "/PlaybackInfo?UserId=" + getSetting("userId") + "&StartTimeTicks=0&IsPlayback=true&AutoOpenLiveStream=true&MaxStreamingBitrate=20000000"
    emby(path, { kind: "playinfo", id: id, title: title }, "POST", FormatJson({ DeviceProfile: deviceProfile() }))
end sub

sub gotPlayInfo(r as object, ctx as object)
    setStatus("")
    json = invalid
    if r.status = 200 then json = ParseJson(r.body)
    if json = invalid or json.MediaSources = invalid or json.MediaSources.Count() = 0
        setStatus("This video can't be played on Roku right now.")
        return
    end if
    src = json.MediaSources[0]
    sessionId = s(json.PlaySessionId)
    token = getSetting("token")
    url = ""
    fmt = "hls"
    if src.SupportsDirectPlay = true
        url = server() + "/emby/Videos/" + ctx.id + "/stream?Static=true&MediaSourceId=" + s(src.Id) + "&api_key=" + token + "&DeviceId=" + m.deviceId + "&PlaySessionId=" + sessionId
        fmt = s(src.Container)
        if Instr(1, fmt, ",") > 0 then fmt = Left(fmt, Instr(1, fmt, ",") - 1)
        if fmt = "" then fmt = "mp4"
        method = "DirectPlay"
    else if src.TranscodingUrl <> invalid
        t = src.TranscodingUrl
        if Left(t, 4) = "http"
            url = t
        else if Left(t, 5) = "/emby"
            url = server() + t
        else
            url = server() + "/emby" + t
        end if
        if Instr(1, url, "api_key=") = 0
            if Instr(1, url, "?") > 0 then url = url + "&api_key=" + token else url = url + "?api_key=" + token
        end if
        method = "Transcode"
    else
        setStatus("This video can't be played on Roku right now.")
        return
    end if
    m.session = { itemId: ctx.id, sourceId: s(src.Id), playSessionId: sessionId, method: method }
    startVideo(url, fmt, ctx.title, false)
    report("/Sessions/Playing", 0&)
end sub

' Tells the server what is playing (so Continue Watching is right, and Aurora Guard sees this device).
sub report(path as string, ticks as longinteger)
    if m.session = invalid then return
    body = FormatJson({ ItemId: m.session.itemId, MediaSourceId: m.session.sourceId, PlaySessionId: m.session.playSessionId, PlayMethod: m.session.method, PositionTicks: ticks, CanSeek: true })
    emby(path, { kind: "report" }, "POST", body)
end sub

sub startVideo(url as string, fmt as string, title as string, isLive as boolean)
    c = CreateObject("roSGNode", "ContentNode")
    c.url = url
    c.streamformat = fmt
    c.title = title
    c.live = isLive
    m.video.content = c
    m.video.visible = true
    m.video.control = "play"
    m.video.setFocus(true)
    m.isLive = isLive
    showBanner(title)
end sub

sub stopVideo()
    if m.session <> invalid
        ticks = 0&
        if m.video.position <> invalid then ticks = Int(m.video.position) * 10000000&
        report("/Sessions/Playing/Stopped", ticks)
        m.session = invalid
    end if
    m.video.control = "stop"
    m.video.visible = false
    m.banner.visible = false
    if m.mode = "episodes"
        m.list2.setFocus(true)
    else if m.mode = "live"
        m.grid.setFocus(true)
    else
        m.grid.setFocus(true)
    end if
end sub

sub onVideoState()
    st = m.video.state
    if st = "finished"
        stopVideo()
    else if st = "error"
        if m.isLive = true
            showBanner("This channel isn't playing. Press up or down for another one.")
        else
            stopVideo()
            setStatus("This video couldn't be played.")
        end if
    end if
end sub

sub showBanner(text as string)
    m.banner.text = text
    m.banner.visible = true
    m.hideTimer = CreateObject("roSGNode", "Timer")
    m.hideTimer.duration = 5
    m.hideTimer.repeat = false
    m.hideTimer.observeField("fire", "hideBanner")
    m.hideTimer.control = "start"
end sub

sub hideBanner()
    m.banner.visible = false
end sub

' ----- Live TV -----

sub loadLive()
    layoutFor("live")
    m.grid.content = invalid
    m.list2.content = invalid
    if m.live <> invalid
        showLiveCategories()
        return
    end if
    setStatus("Loading...")
    emby("/DisplayPreferences/aurora-livetv?userId=" + getSetting("userId") + "&client=aurora", { kind: "liveprefs" })
end sub

sub gotLivePrefs(r as object)
    cfg = invalid
    if r.status = 200
        json = ParseJson(r.body)
        if json <> invalid and json.CustomPrefs <> invalid and json.CustomPrefs.config <> invalid then cfg = ParseJson(json.CustomPrefs.config)
    end if
    ready = false
    if cfg <> invalid
        t = s(cfg.type)
        if t = "m3u" and s(cfg.m3uUrl) <> "" then ready = true
        if t = "xtream" and s(cfg.server) <> "" and s(cfg.username) <> "" then ready = true
    end if
    if not ready
        setStatus("Live TV isn't set up on your account yet.")
        return
    end if
    m.live = cfg
    showLiveCategories()
end sub

function providerBase() as string
    a = s(m.live.server).Trim()
    if LCase(Left(a, 7)) <> "http://" and LCase(Left(a, 8)) <> "https://" then a = "http://" + a
    while Right(a, 1) = "/"
        a = Left(a, Len(a) - 1)
    end while
    return a
end function

function providerHeaders() as object
    h = {}
    ua = s(m.live.userAgent)
    if ua <> "" then h["User-Agent"] = ua
    return h
end function

sub showLiveCategories()
    setStatus("Loading channels...")
    if s(m.live.type) = "m3u"
        a = s(m.live.m3uUrl).Trim()
        if LCase(Left(a, 4)) <> "http" then a = "http://" + a
        request(a, { kind: "m3u" }, providerHeaders())
    else
        url = providerBase() + "/player_api.php?username=" + encode(s(m.live.username)) + "&password=" + encode(s(m.live.password)) + "&action=get_live_categories"
        request(url, { kind: "xcats" }, providerHeaders())
    end if
end sub

function encode(text as string) as string
    return CreateObject("roUrlTransfer").Escape(text)
end function

' Adult categories are never shown in the Apple apps or on Roku, whatever the account's settings say.
function categoryAllowed(id as string, name as string) as boolean
    cfg = m.live
    adult = cfg.adultCats
    if adult <> invalid
        for each a in adult
            if s(a) = id then return false
        end for
    else
        re = CreateObject("roRegex", "(adult(?!\s*swim)|xxx|18\s*\+|\+\s*18|porn|erotic|nsfw|hentai|playboy|\bsex\b|\bsexy\b)", "i")
        if re.IsMatch(name) then return false
    end if
    shown = cfg.catsShown
    if shown <> invalid
        for each a in shown
            if s(a) = id then return true
        end for
        return false
    end if
    hidden = cfg.catsHidden
    if hidden <> invalid
        for each a in hidden
            if s(a) = id then return false
        end for
    end if
    return true
end function

sub fillCategories(names as object, ids as object)
    root = CreateObject("roSGNode", "ContentNode")
    for i = 0 to names.Count() - 1
        if categoryAllowed(ids[i], names[i])
            c = root.CreateChild("ContentNode")
            c.title = names[i]
            c.id = ids[i]
        end if
    end for
    if root.getChildCount() = 0
        setStatus("There are no channels to show.")
        return
    end if
    setStatus("")
    m.list2.content = root
    m.list2.visible = true
end sub

sub gotXtreamCats(r as object)
    list = invalid
    if r.status = 200 then list = ParseJson(r.body)
    if list = invalid or type(list) <> "roArray"
        setStatus("Couldn't load the channels. Check your connection and try again.")
        return
    end if
    names = []
    ids = []
    for each c in list
        names.Push(s(c.category_name))
        ids.Push(s(c.category_id))
    end for
    fillCategories(names, ids)
end sub

sub loadChannels(catId as string)
    if s(m.live.type) = "m3u"
        showChannels(m.m3uGroups[catId])
        return
    end if
    setStatus("Loading...")
    url = providerBase() + "/player_api.php?username=" + encode(s(m.live.username)) + "&password=" + encode(s(m.live.password)) + "&action=get_live_streams&category_id=" + encode(catId)
    request(url, { kind: "xstreams", cat: catId }, providerHeaders())
end sub

sub gotXtreamStreams(r as object, ctx as object)
    list = invalid
    if r.status = 200 then list = ParseJson(r.body)
    if list = invalid or type(list) <> "roArray"
        setStatus("Couldn't load that category.")
        return
    end if
    chans = []
    base = providerBase() + "/live/" + encode(s(m.live.username)) + "/" + encode(s(m.live.password)) + "/"
    for each st in list
        sid = s(st.stream_id)
        if sid <> ""
            chans.Push({ name: s(st.name), logo: s(st.stream_icon), num: s(st.num), url: base + sid + ".m3u8" })
        end if
    end for
    showChannels(chans)
end sub

sub gotM3u(r as object)
    if r.status <> 200 or Instr(1, r.body, "#EXT") = 0
        setStatus("Couldn't load the channels. Check your connection and try again.")
        return
    end if
    groups = {}
    name = ""
    logo = ""
    group = ""
    num = ""
    have = false
    reTs = CreateObject("roRegex", "^(.*/live/.+)\.ts((\?.*)?)$", "i")
    for each raw in r.body.Split(Chr(10))
        line = raw.Trim()
        if Left(line, 7) = "#EXTINF"
            logo = attr(line, "tvg-logo")
            group = attr(line, "group-title")
            num = attr(line, "tvg-chno")
            cut = Instr(1, line, ",")
            if cut > 0 then name = Mid(line, cut + 1).Trim() else name = ""
            if name = "" then name = attr(line, "tvg-name")
            have = true
        else if line <> "" and Left(line, 1) <> "#" and have
            if group = "" then group = "Channels"
            url = line
            if reTs.IsMatch(url)
                parts = reTs.Match(url)
                url = parts[1] + ".m3u8" + parts[2]
            end if
            if not groups.DoesExist(group) then groups[group] = []
            groups[group].Push({ name: name, logo: logo, num: num, url: url })
            have = false
        end if
    end for
    m.m3uGroups = groups
    names = []
    for each g in groups
        names.Push(g)
    end for
    names.Sort()
    fillCategories(names, names)
end sub

function attr(line as string, key as string) as string
    p = Instr(1, LCase(line), key + "=" + Chr(34))
    if p = 0 then return ""
    start = p + Len(key) + 2
    e = Instr(start, line, Chr(34))
    if e = 0 then return ""
    return Mid(line, start, e - start)
end function

sub showChannels(chans as object)
    if chans = invalid or chans.Count() = 0
        setStatus("There are no channels in this category.")
        m.grid.content = invalid
        return
    end if
    setStatus("")
    m.channels = chans
    root = CreateObject("roSGNode", "ContentNode")
    for each ch in chans
        c = root.CreateChild("ContentNode")
        c.title = ch.name
        c.shortdescriptionline1 = ch.name
        c.hdgridposterurl = ch.logo
    end for
    m.grid.content = root
    m.grid.setFocus(true)
end sub

sub playChannel(index as integer)
    if m.channels.Count() = 0 then return
    if index < 0 then index = m.channels.Count() - 1
    if index >= m.channels.Count() then index = 0
    m.channelIndex = index
    ch = m.channels[index]
    title = ch.name
    if ch.num <> "" then title = ch.num + "  " + ch.name
    startVideo(ch.url, "hls", title, true)
end sub

' ----- Remote control -----

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.video.visible
        if key = "back"
            stopVideo()
            return true
        end if
        if m.isLive = true
            if key = "up"
                playChannel(m.channelIndex + 1)
                return true
            else if key = "down"
                playChannel(m.channelIndex - 1)
                return true
            end if
        end if
        return false
    end if
    if m.signin.visible then return false
    if key = "back"
        if m.mode = "episodes"
            m.list2.visible = false
            m.grid.visible = true
            m.mode = "shows"
            m.grid.setFocus(true)
            return true
        end if
        if m.menu.hasFocus() then return false
        m.menu.setFocus(true)
        return true
    end if
    if key = "right" and m.menu.hasFocus()
        if m.list2.visible and m.mode = "live" and m.list2.content <> invalid
            m.list2.setFocus(true)
        else
            m.grid.setFocus(true)
        end if
        return true
    end if
    if key = "left"
        if m.mode = "live" and m.grid.hasFocus()
            m.list2.setFocus(true)
            return true
        end if
        if not m.menu.hasFocus() and m.mode <> "episodes"
            m.menu.setFocus(true)
            return true
        end if
    end if
    if key = "right" and m.mode = "live" and m.list2.hasFocus() and m.grid.content <> invalid
        m.grid.setFocus(true)
        return true
    end if
    return false
end function
