' Aurora for Roku. One scene, several views; `m.stack` remembers where Back goes.

sub init()
    m.pending = {}
    m.taskId = 0
    m.stack = []
    m.view = ""
    for each id in ["loginView", "homeView", "gridView", "detailsView"]
        m[id] = m.top.findNode(id)
    end for
    for each id in ["userBtn", "passBtn", "signInBtn", "loginMsg", "rowList", "grid", "gridMsg", "dPoster", "dTitle", "dMeta", "dOverview", "dButtons", "seasonList", "episodeList", "dHint", "video", "busy", "progressTimer", "crumb"]
        m[id] = m.top.findNode(id)
    end for
    m.userBtn.observeField("buttonSelected", "onUserBtn")
    m.passBtn.observeField("buttonSelected", "onPassBtn")
    m.signInBtn.observeField("buttonSelected", "onSignIn")
    m.rowList.observeField("rowItemSelected", "onRowSelected")
    m.grid.observeField("itemSelected", "onGridSelected")
    m.seasonList.observeField("itemSelected", "onSeasonSelected")
    m.episodeList.observeField("itemSelected", "onEpisodeSelected")
    m.dButtons.observeField("buttonSelected", "onDetailButton")
    m.video.observeField("state", "onVideoState")
    m.progressTimer.observeField("fire", "onProgressTimer")
    m.username = ""
    m.password = ""
    m.playing = invalid
    m.configUrls = [
        "https://raw.githubusercontent.com/johnny4091-allstar/johnny4091-allstar/main/aurora-config.json"
    ]
    m.configTry = 0
    tourInit()
    checkForUpdate()
    start()
end sub

' ---------- Web requests ----------

function enc(s as string) as string
    return CreateObject("roUrlTransfer").Escape(s)
end function

function txt(v as dynamic) as string
    if v = invalid then return ""
    t = type(v)
    if t = "String" or t = "roString" then return v
    return box(v).toStr()
end function

function authHeader() as string
    g = m.global
    return "MediaBrowser UserId=" + Chr(34) + g.userId + Chr(34) + ", Client=" + Chr(34) + "Aurora" + Chr(34) + ", Device=" + Chr(34) + "Roku " + g.deviceName + Chr(34) + ", DeviceId=" + Chr(34) + g.deviceId + Chr(34) + ", Version=" + Chr(34) + "1.0" + Chr(34)
end function

function apiUrl(path as string, params as object) as string
    url = m.global.server + "/emby" + path
    sep = "?"
    if params <> invalid
        for each k in params
            url += sep + k + "=" + enc(txt(params[k]))
            sep = "&"
        end for
    end if
    return url
end function

' Sends a request; `done` is the name of the function that gets the answer.
sub call(method as string, path as string, params as object, body as dynamic, done as string)
    m.taskId++
    id = "t" + txt(m.taskId)
    task = CreateObject("roSGNode", "ApiTask")
    headers = { "X-Emby-Authorization": authHeader(), "Accept": "application/json", "Content-Type": "application/json" }
    if m.global.token <> "" then headers["X-Emby-Token"] = m.global.token
    payload = ""
    if body <> invalid then payload = FormatJson(body)
    task.request = { method: method, url: apiUrl(path, params), headers: headers, body: payload }
    task.observeField("response", done)
    m.pending[id] = task
    task.control = "RUN"
end sub

sub get(path as string, params as object, done as string)
    call("GET", path, params, invalid, done)
end sub

sub ignore(event as object)
    answer(event)
end sub

' The answer to a request. Also lets go of the finished request, so they don't pile up over a long session.
function answer(event as object) as object
    node = event.getRoSGNode()
    for each id in m.pending
        if m.pending[id].isSameNode(node)
            m.pending.Delete(id)
            exit for
        end if
    end for
    return event.getData()
end function

' ---------- Updates ----------
' A sideloaded Roku app can't replace itself, so this tells the viewer when a newer version exists.
' aurora-config.json in the repository carries "rokuBuild" (newest) and "rokuMinBuild" (oldest still allowed).

function myBuild() as integer
    return Val(CreateObject("roAppInfo").GetValue("build_version"))
end function

sub checkForUpdate()
    if m.configTry >= m.configUrls.count() then return
    task = CreateObject("roSGNode", "ApiTask")
    task.request = { method: "GET", url: m.configUrls[m.configTry], headers: { "Accept": "application/json" }, body: "" }
    task.observeField("response", "onConfig")
    m.pending["config"] = task
    task.control = "RUN"
end sub

sub onConfig(event as object)
    r = answer(event)
    cfg = invalid
    if r.ok and r.json <> invalid and type(r.json) = "roAssociativeArray" then cfg = r.json
    if cfg = invalid or (cfg.rokuBuild = invalid and cfg.rokuMinBuild = invalid)
        m.configTry++
        checkForUpdate()
        return
    end if
    mine = myBuild()
    if cfg.rokuMinBuild <> invalid and mine < cfg.rokuMinBuild
        m.updateRequired = true
        showUpdateDialog("This version of Aurora is out of date and can't be used any more. Install the newest version (build " + txt(cfg.rokuBuild) + ") and open Aurora again.")
    else if cfg.rokuBuild <> invalid and mine < cfg.rokuBuild
        showUpdateDialog("A newer version of Aurora is available (build " + txt(cfg.rokuBuild) + ", you have " + txt(mine) + "). Install it the same way you installed this one.")
    end if
end sub

sub showUpdateDialog(message as string)
    dlg = CreateObject("roSGNode", "Dialog")
    dlg.title = "Update available"
    dlg.message = message
    dlg.buttons = ["OK"]
    dlg.observeField("buttonSelected", "onUpdateDialog")
    ' Back closes a dialog without choosing a button: a required update must come back either way.
    dlg.observeField("wasClosed", "onUpdateDialogClosed")
    m.top.dialog = dlg
end sub

sub onUpdateDialogClosed()
    if m.updateRequired = true and m.updateReopening <> true
        m.updateReopening = true
        showUpdateDialog("Please install the newest version of Aurora to carry on.")
        m.updateReopening = false
    end if
end sub

sub onUpdateDialog()
    ' Closing it also fires wasClosed, which brings it back again if the update is required.
    m.top.dialog.close = true
end sub

' ---------- Start up and sign in ----------

sub start()
    reg = CreateObject("roRegistrySection", "aurora")
    if reg.Exists("token") and reg.Exists("userId")
        m.global.token = reg.Read("token")
        m.global.userId = reg.Read("userId")
        busy(true)
        m.sessionTries = 0
        get("/Users/" + m.global.userId, {}, "onSessionChecked")
    else
        showLogin("")
    end if
end sub

sub onSessionChecked(event as object)
    r = answer(event)
    if r.ok
        busy(false)
        showHome()
    else if r.status = 401 or r.status = 403
        ' The server no longer accepts this sign-in.
        busy(false)
        signOutLocal()
        showLogin("")
    else if m.sessionTries < 5
        ' No network yet (the Roku just started) or the server is briefly down: keep the sign-in and try again.
        m.sessionTries++
        m.retryTimer = CreateObject("roSGNode", "Timer")
        m.retryTimer.duration = 3
        m.retryTimer.observeField("fire", "retrySession")
        m.retryTimer.control = "start"
    else
        busy(false)
        showLogin("Can't reach the server. Check the connection and try again.")
    end if
end sub

sub retrySession()
    get("/Users/" + m.global.userId, {}, "onSessionChecked")
end sub

sub showLogin(message as string)
    m.stack = []
    show("loginView")
    m.crumb.text = ""
    m.loginMsg.text = message
    m.userBtn.text = "Username: " + m.username
    m.passBtn.text = "Password: " + String(Len(m.password), Chr(8226))
    m.userBtn.setFocus(true)
end sub

sub keyboard(title as string, text as string, secure as boolean, done as string)
    dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
    dlg.title = title
    dlg.text = text
    dlg.buttons = ["OK", "Cancel"]
    if secure then dlg.textEditBox.secureMode = true
    m.dialog = dlg
    dlg.observeField("buttonSelected", done)
    m.top.dialog = dlg
end sub

sub onUserBtn()
    keyboard("Username", m.username, false, "onUserDone")
end sub

sub onUserDone()
    if m.dialog.buttonSelected = 0 then m.username = m.dialog.text
    m.top.dialog.close = true
    m.userBtn.text = "Username: " + m.username
    m.userBtn.setFocus(true)
end sub

sub onPassBtn()
    keyboard("Password", m.password, true, "onPassDone")
end sub

sub onPassDone()
    if m.dialog.buttonSelected = 0 then m.password = m.dialog.text
    m.top.dialog.close = true
    m.passBtn.text = "Password: " + String(Len(m.password), Chr(8226))
    m.passBtn.setFocus(true)
end sub

sub onSignIn()
    if m.username = "" then
        m.loginMsg.text = "Enter your username first."
        return
    end if
    m.loginMsg.text = "Signing in…"
    m.global.token = ""
    m.global.userId = ""
    call("POST", "/Users/AuthenticateByName", {}, { Username: m.username, Pw: m.password }, "onSignedIn")
end sub

sub onSignedIn(event as object)
    r = answer(event)
    if r.ok and r.json <> invalid and r.json.AccessToken <> invalid
        m.global.token = r.json.AccessToken
        m.global.userId = r.json.User.Id
        reg = CreateObject("roRegistrySection", "aurora")
        reg.Write("token", m.global.token)
        reg.Write("userId", m.global.userId)
        reg.Flush()
        m.password = ""
        showHome()
    else if r.status = 401 or r.status = 403
        m.loginMsg.text = "That username or password isn't right, or the account is turned off."
    else if r.status = 0
        m.loginMsg.text = "Could not reach the Aurora server. Check your internet connection and try again."
    else
        m.loginMsg.text = "Could not sign in (" + txt(r.status) + "). Try again."
    end if
end sub

sub signOutLocal()
    reg = CreateObject("roRegistrySection", "aurora")
    reg.Delete("token")
    reg.Delete("userId")
    reg.Flush()
    m.global.token = ""
    m.global.userId = ""
end sub

sub signOut()
    if m.global.token <> "" then call("POST", "/Sessions/Logout", {}, invalid, "ignore")
    signOutLocal()
    m.username = ""
    m.password = ""
    showLogin("")
end sub

' ---------- Views ----------

sub show(name as string)
    for each v in ["loginView", "homeView", "gridView", "detailsView"]
        m[v].visible = (v = name)
    end for
    m.view = name
end sub

sub busy(on as boolean)
    m.busy.visible = on
end sub

sub push(name as string)
    m.stack.push(name)
end sub

' ---------- Home ----------

sub showHome()
    m.stack = []
    show("homeView")
    m.crumb.text = ""
    m.homeLeft = 4
    m.homeRows = { resume: invalid, nextup: invalid, movies: invalid, shows: invalid }
    busy(true)
    uid = m.global.userId
    common = { Limit: 20, Fields: "Overview,ProductionYear,RunTimeTicks", ImageTypeLimit: 1, EnableImageTypes: "Primary" }
    p = {}
    p.append(common)
    p.Filters = "IsResumable"
    p.Recursive = true
    p.IncludeItemTypes = "Movie,Episode"
    p.SortBy = "DatePlayed"
    p.SortOrder = "Descending"
    get("/Users/" + uid + "/Items", p, "onHomeResume")
    n = { UserId: uid, Limit: 20, Fields: "Overview,ProductionYear,RunTimeTicks", ImageTypeLimit: 1, EnableImageTypes: "Primary" }
    get("/Shows/NextUp", n, "onHomeNextUp")
    l1 = { Limit: 20, IncludeItemTypes: "Movie", Fields: "ProductionYear", ImageTypeLimit: 1, EnableImageTypes: "Primary" }
    get("/Users/" + uid + "/Items/Latest", l1, "onHomeMovies")
    l2 = { Limit: 20, IncludeItemTypes: "Series", Fields: "ProductionYear", ImageTypeLimit: 1, EnableImageTypes: "Primary" }
    get("/Users/" + uid + "/Items/Latest", l2, "onHomeShows")
end sub

function itemsOf(r as object) as object
    if not r.ok or r.json = invalid then return []
    if type(r.json) = "roArray" then return r.json
    if r.json.Items <> invalid then return r.json.Items
    return []
end function

sub onHomeResume(event as object)
    m.homeRows.resume = itemsOf(answer(event))
    homeStep()
end sub
sub onHomeNextUp(event as object)
    m.homeRows.nextup = itemsOf(answer(event))
    homeStep()
end sub
sub onHomeMovies(event as object)
    m.homeRows.movies = itemsOf(answer(event))
    homeStep()
end sub
sub onHomeShows(event as object)
    m.homeRows.shows = itemsOf(answer(event))
    homeStep()
end sub

sub homeStep()
    m.homeLeft--
    if m.homeLeft > 0 then return
    busy(false)
    root = CreateObject("roSGNode", "ContentNode")
    ' Browse tiles first.
    browse = CreateObject("roSGNode", "ContentNode")
    browse.title = "Browse"
    for each t in [["Movies", "movies"], ["TV Shows", "shows"], ["Search", "search"], ["Replay tour", "tour"], ["Sign out", "signout"]]
        n = CreateObject("roSGNode", "ContentNode")
        n.title = t[0]
        n.addFields({ action: t[1], embyId: "", embyType: "" })
        browse.appendChild(n)
    end for
    root.appendChild(browse)
    addRow(root, "Continue Watching", m.homeRows.resume)
    addRow(root, "Next Up", m.homeRows.nextup)
    addRow(root, "New Movies", m.homeRows.movies)
    addRow(root, "New TV Shows", m.homeRows.shows)
    m.rowList.content = root
    m.rowList.setFocus(true)
    maybeStartTour()
end sub

sub addRow(root as object, title as string, items as object)
    if items = invalid or items.count() = 0 then return
    row = CreateObject("roSGNode", "ContentNode")
    row.title = title
    for each it in items
        row.appendChild(makeNode(it))
    end for
    root.appendChild(row)
end sub

function posterUrl(it as object) as string
    id = it.Id
    tag = ""
    if it.ImageTags <> invalid and it.ImageTags.Primary <> invalid
        tag = it.ImageTags.Primary
    else if it.SeriesId <> invalid and it.SeriesPrimaryImageTag <> invalid
        id = it.SeriesId
        tag = it.SeriesPrimaryImageTag
    else
        return ""
    end if
    return apiUrl("/Items/" + id + "/Images/Primary", { maxHeight: 400, quality: 85, tag: tag, api_key: m.global.token })
end function

function titleOf(it as object) as string
    if it.Type = "Episode"
        label = ""
        if it.SeriesName <> invalid then label = it.SeriesName + " "
        if it.ParentIndexNumber <> invalid and it.IndexNumber <> invalid
            label += "S" + txt(it.ParentIndexNumber) + ":E" + txt(it.IndexNumber)
        else
            label += txt(it.Name)
        end if
        return label
    end if
    return txt(it.Name)
end function

function makeNode(it as object) as object
    n = CreateObject("roSGNode", "ContentNode")
    n.title = titleOf(it)
    n.shortDescriptionLine1 = n.title
    n.HDPosterUrl = posterUrl(it)
    n.addFields({ embyId: it.Id, embyType: txt(it.Type), action: "open" })
    return n
end function

sub onRowSelected()
    sel = m.rowList.rowItemSelected
    row = m.rowList.content.getChild(sel[0])
    node = row.getChild(sel[1])
    act = node.action
    if act = "movies"
        showGrid("Movies", "Movie", "")
    else if act = "shows"
        showGrid("TV Shows", "Series", "")
    else if act = "search"
        askSearch()
    else if act = "tour"
        tourStart()
    else if act = "signout"
        signOut()
    else
        openItem(node.embyId, node.embyType)
    end if
end sub

' ---------- Movies, TV shows and search ----------

sub showGrid(title as string, kind as string, term as string)
    push(m.view)
    show("gridView")
    m.crumb.text = title
    m.grid.content = invalid
    m.gridMsg.text = ""
    busy(true)
    p = { Recursive: true, IncludeItemTypes: kind, SortBy: "SortName", SortOrder: "Ascending", Limit: 600, Fields: "ProductionYear", ImageTypeLimit: 1, EnableImageTypes: "Primary" }
    if term <> "" then p.SearchTerm = term
    if kind = "" then p.IncludeItemTypes = "Movie,Series"
    get("/Users/" + m.global.userId + "/Items", p, "onGridLoaded")
end sub

sub onGridLoaded(event as object)
    busy(false)
    r = answer(event)
    items = itemsOf(r)
    root = CreateObject("roSGNode", "ContentNode")
    for each it in items
        root.appendChild(makeNode(it))
    end for
    m.grid.content = root
    if items.count() = 0
        if r.ok then m.gridMsg.text = "Nothing found." else m.gridMsg.text = "Could not load the list. Press Back and try again."
    end if
    m.grid.setFocus(true)
end sub

sub onGridSelected()
    node = m.grid.content.getChild(m.grid.itemSelected)
    openItem(node.embyId, node.embyType)
end sub

sub askSearch()
    keyboard("Search", "", false, "onSearchDone")
end sub

sub onSearchDone()
    ok = (m.dialog.buttonSelected = 0)
    term = m.dialog.text
    m.top.dialog.close = true
    if ok and term <> ""
        showGrid("Results for " + term, "", term)
    else
        m.rowList.setFocus(true)
    end if
end sub

' ---------- Details ----------

sub openItem(id as string, kind as string)
    push(m.view)
    show("detailsView")
    m.crumb.text = ""
    m.dTitle.text = ""
    m.dMeta.text = ""
    m.dOverview.text = ""
    m.dPoster.uri = ""
    m.dButtons.buttons = []
    m.seasonList.visible = false
    m.episodeList.visible = false
    m.dHint.visible = false
    m.item = invalid
    ' Nothing from the title before this one may be shown or changed by a late answer.
    m.openId = id
    m.seasons = []
    m.episodes = []
    m.seasonId = ""
    busy(true)
    get("/Users/" + m.global.userId + "/Items/" + id, {}, "onItemLoaded")
end sub

sub onItemLoaded(event as object)
    busy(false)
    r = answer(event)
    if not r.ok or r.json = invalid
        m.dTitle.text = "Could not load this title"
        m.dOverview.text = "Press Back and try again. If the title was removed or replaced, refresh the list."
        return
    end if
    it = r.json
    if it.Id <> m.openId then return ' a late answer for a title the viewer already left
    m.item = it
    m.dTitle.text = txt(it.Name)
    meta = []
    if it.ProductionYear <> invalid then meta.push(txt(it.ProductionYear))
    if it.OfficialRating <> invalid then meta.push(it.OfficialRating)
    if it.RunTimeTicks <> invalid and it.Type <> "Series" then meta.push(txt(Int(it.RunTimeTicks / 600000000)) + " min")
    m.dMeta.text = meta.join("  ·  ")
    m.dOverview.text = txt(it.Overview)
    m.dPoster.uri = posterUrl(it)
    if it.Type = "Series"
        m.dButtons.buttons = []
        m.dHint.visible = true
        get("/Shows/" + it.Id + "/Seasons", { UserId: m.global.userId }, "onSeasons")
    else
        setPlayButtons()
    end if
end sub

sub setPlayButtons()
    it = m.item
    startPos = 0
    if it.UserData <> invalid and it.UserData.PlaybackPositionTicks <> invalid then startPos = it.UserData.PlaybackPositionTicks
    buttons = []
    if startPos > 0
        buttons.push("Resume from " + clock(startPos))
        buttons.push("Play from start")
    else
        buttons.push("Play")
    end if
    if it.UserData <> invalid and it.UserData.Played = true
        buttons.push("Mark as unwatched")
    else
        buttons.push("Mark as watched")
    end if
    m.dButtons.buttons = buttons
    m.dButtons.setFocus(true)
end sub

function clock(ticks as dynamic) as string
    s = Int(ticks / 10000000)
    h = Int(s / 3600)
    mm = Int((s mod 3600) / 60)
    ss = s mod 60
    t = ""
    if h > 0 then t = txt(h) + ":" + Right("0" + txt(mm), 2) else t = txt(mm)
    return t + ":" + Right("0" + txt(ss), 2)
end function

sub onDetailButton()
    label = m.dButtons.getChild(m.dButtons.buttonSelected).text
    if Left(label, 6) = "Resume"
        startPos = m.item.UserData.PlaybackPositionTicks
        play(m.item, startPos)
    else if Left(label, 4) = "Play"
        play(m.item, 0)
    else
        on = (label = "Mark as watched")
        setPlayed(m.item.Id, on)
        if m.item.UserData = invalid then m.item.UserData = {}
        m.item.UserData.Played = on
        setPlayButtons()
    end if
end sub

sub setPlayed(id as string, on as boolean)
    method = "DELETE"
    if on then method = "POST"
    call(method, "/Users/" + m.global.userId + "/PlayedItems/" + id, {}, invalid, "ignore")
end sub

sub onSeasons(event as object)
    r = answer(event)
    items = itemsOf(r)
    if m.item = invalid then return
    if items.count() > 0 and items[0].SeriesId <> invalid and items[0].SeriesId <> m.item.Id then return ' another show's seasons
    m.seasons = items
    root = CreateObject("roSGNode", "ContentNode")
    for each s in items
        n = CreateObject("roSGNode", "ContentNode")
        n.title = txt(s.Name)
        n.addFields({ embyId: s.Id })
        root.appendChild(n)
    end for
    m.seasonList.content = root
    m.seasonList.visible = (items.count() > 0)
    if items.count() = 0 then return
    pick = 0
    for i = 0 to items.count() - 1
        if items[i].IndexNumber <> invalid and items[i].IndexNumber > 0
            pick = i
            exit for
        end if
    end for
    m.seasonList.jumpToItem = pick
    loadEpisodes(items[pick].Id)
    m.seasonList.setFocus(true)
end sub

sub onSeasonSelected()
    s = m.seasons[m.seasonList.itemSelected]
    loadEpisodes(s.Id)
    m.episodeList.setFocus(true)
end sub

sub loadEpisodes(seasonId as string)
    m.seasonId = seasonId
    p = { SeasonId: seasonId, UserId: m.global.userId, Fields: "Overview,RunTimeTicks" }
    get("/Shows/" + m.item.Id + "/Episodes", p, "onEpisodes")
end sub

sub onEpisodes(event as object)
    items = itemsOf(answer(event))
    if items.count() > 0 and items[0].SeasonId <> invalid and items[0].SeasonId <> m.seasonId then return ' another season's episodes (a late answer)
    m.episodes = items
    root = CreateObject("roSGNode", "ContentNode")
    for each e in items
        n = CreateObject("roSGNode", "ContentNode")
        mark = ""
        if e.UserData <> invalid and e.UserData.Played = true then mark = "  ✓"
        n.title = txt(e.IndexNumber) + ".  " + txt(e.Name) + mark
        root.appendChild(n)
    end for
    m.episodeList.content = root
    m.episodeList.visible = true
end sub

sub onEpisodeSelected()
    e = m.episodes[m.episodeList.itemSelected]
    startPos = 0
    if e.UserData <> invalid and e.UserData.PlaybackPositionTicks <> invalid then startPos = e.UserData.PlaybackPositionTicks
    m.playIndex = m.episodeList.itemSelected
    play(e, startPos)
end sub

sub toggleEpisode()
    i = m.episodeList.itemFocused
    if i < 0 or m.episodes = invalid or i >= m.episodes.count() then return
    e = m.episodes[i]
    on = not (e.UserData <> invalid and e.UserData.Played = true)
    setPlayed(e.Id, on)
    if e.UserData = invalid then e.UserData = {}
    e.UserData.Played = on
    repaintEpisodes(i)
end sub

sub repaintEpisodes(focusIndex as integer)
    root = CreateObject("roSGNode", "ContentNode")
    for each e in m.episodes
        n = CreateObject("roSGNode", "ContentNode")
        mark = ""
        if e.UserData <> invalid and e.UserData.Played = true then mark = "  ✓"
        n.title = txt(e.IndexNumber) + ".  " + txt(e.Name) + mark
        root.appendChild(n)
    end for
    m.episodeList.content = root
    m.episodeList.jumpToItem = focusIndex
end sub

sub markSeason()
    i = m.seasonList.itemFocused
    if i < 0 or m.seasons = invalid or i >= m.seasons.count() or m.episodes = invalid then return
    sid = m.seasons[i].Id
    if sid <> m.seasonId
        loadEpisodes(sid)
        return
    end if
    all = true
    for each e in m.episodes
        if not (e.UserData <> invalid and e.UserData.Played = true) then all = false
    end for
    on = not all
    for each e in m.episodes
        if e.UserData = invalid then e.UserData = {}
        if (e.UserData.Played = true) <> on then setPlayed(e.Id, on)
        e.UserData.Played = on
    end for
    repaintEpisodes(0)
end sub

' ---------- Playback ----------

function deviceProfile() as object
    return {
        Name: "Aurora Roku"
        MaxStreamingBitrate: 20000000
        DirectPlayProfiles: [
            { Container: "mp4,m4v,mov", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3,eac3,mp3" }
            { Container: "mkv", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3,eac3,mp3" }
        ]
        TranscodingProfiles: [
            { Container: "ts", Type: "Video", AudioCodec: "aac,ac3", VideoCodec: "h264", Protocol: "hls", Context: "Streaming", MaxAudioChannels: "6", MinSegments: "1", BreakOnNonKeyFrames: true }
        ]
        SubtitleProfiles: [{ Format: "srt", Method: "External" }]
    }
end function

sub play(item as object, startTicks as dynamic)
    m.playing = { item: item, start: startTicks, started: false, offset: 0 }
    busy(true)
    p = { UserId: m.global.userId, IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: 20000000 }
    if startTicks > 0 then p.StartTimeTicks = startTicks
    call("POST", "/Items/" + item.Id + "/PlaybackInfo", p, { DeviceProfile: deviceProfile() }, "onPlaybackInfo")
end sub

sub onPlaybackInfo(event as object)
    r = answer(event)
    busy(false)
    if not r.ok or r.json = invalid or r.json.MediaSources = invalid or r.json.MediaSources.count() = 0
        playFailed("This video couldn't be played. Try again later.")
        return
    end if
    src = r.json.MediaSources[0]
    it = m.playing.item
    c = CreateObject("roSGNode", "ContentNode")
    c.title = txt(it.Name)
    if src.TranscodingUrl <> invalid
        url = m.global.server + src.TranscodingUrl
        if Instr(1, url, "api_key=") = 0 then url += "&api_key=" + m.global.token
        c.url = url
        c.streamFormat = "hls"
        m.playing.method = "Transcode"
    else
        container = "mp4"
        if src.Container <> invalid then container = src.Container
        comma = Instr(1, container, ",")
        if comma > 0 then container = Left(container, comma - 1)
        c.url = apiUrl("/Videos/" + it.Id + "/stream." + container, { Static: true, MediaSourceId: src.Id, PlaySessionId: r.json.PlaySessionId, DeviceId: m.global.deviceId, api_key: m.global.token })
        c.streamFormat = container
        if src.SupportsDirectPlay = true then m.playing.method = "DirectPlay" else m.playing.method = "DirectStream"
    end if
    ' A converted stream already begins at the resume point (Emby was told StartTimeTicks), so don't seek into it again;
    ' instead remember the offset: the player's position is then counted from that point.
    m.playing.offset = 0
    if m.playing.start > 0
        if m.playing.method = "Transcode" then m.playing.offset = Int(m.playing.start / 10000000) else c.PlayStart = Int(m.playing.start / 10000000)
    end if
    m.playing.sourceId = src.Id
    m.playing.session = txt(r.json.PlaySessionId)
    m.video.content = c
    m.video.visible = true
    m.video.setFocus(true)
    m.video.control = "play"
end sub

sub playFailed(message as string)
    busy(false)
    dlg = CreateObject("roSGNode", "Dialog")
    dlg.title = "Aurora"
    dlg.message = message
    dlg.buttons = ["OK"]
    dlg.observeField("buttonSelected", "onDialogClosed")
    m.top.dialog = dlg
end sub

sub onDialogClosed()
    m.top.dialog.close = true
end sub

function reportBody(paused as boolean, seconds as dynamic) as object
    p = m.playing
    return {
        ItemId: p.item.Id, MediaSourceId: p.sourceId, PlaySessionId: p.session,
        PositionTicks: (Int(seconds) + p.offset) * 10000000&, IsPaused: paused, PlayMethod: p.method, CanSeek: true
    }
end function

sub onVideoState()
    st = m.video.state
    if m.playing = invalid then return
    if st = "playing"
        if not m.playing.started
            m.playing.started = true
            call("POST", "/Sessions/Playing", {}, reportBody(false, m.video.position), "ignore")
            m.progressTimer.control = "start"
        end if
    else if st = "finished"
        finishPlayback(true)
    else if st = "error"
        msg = "This video stopped playing."
        if m.video.errorMsg <> invalid and m.video.errorMsg <> "" then msg += " (" + m.video.errorMsg + ")"
        finishPlayback(false)
        playFailed(msg)
    end if
end sub

sub onProgressTimer()
    if m.playing = invalid or not m.playing.started then return
    call("POST", "/Sessions/Playing/Progress", {}, reportBody(m.video.state = "paused", m.video.position), "ignore")
end sub

' Ends playback: tells the server where it stopped, ticks the item off if it was finished, and goes back.
sub finishPlayback(ended as boolean)
    p = m.playing
    if p = invalid then return
    m.progressTimer.control = "stop"
    startPos = m.video.position
    dur = m.video.duration + p.offset
    if p.item.RunTimeTicks <> invalid then dur = p.item.RunTimeTicks / 10000000
    m.video.control = "stop"
    m.video.visible = false
    if p.started then call("POST", "/Sessions/Playing/Stopped", {}, reportBody(false, startPos), "ignore")
    ' Let the server stop converting this video (it would otherwise carry on for a while).
    if p.method <> invalid and p.session <> invalid
        if p.method = "Transcode" then call("DELETE", "/Videos/ActiveEncodings", { DeviceId: m.global.deviceId, PlaySessionId: p.session }, invalid, "ignore")
    end if
    m.playing = invalid
    done = ended or (dur > 0 and (startPos + p.offset) >= dur * 0.9)
    if done and p.started then setPlayed(p.item.Id, true)
    ' Carry on with the next episode of the season.
    if ended and p.item.Type = "Episode" and m.item <> invalid and m.item.Type = "Series" and m.episodes <> invalid and m.playIndex <> invalid
        nxt = m.playIndex + 1
        if nxt < m.episodes.count()
            m.playIndex = nxt
            e = m.episodes[nxt]
            play(e, 0)
            return
        end if
    end if
    if m.view = "detailsView"
        if m.item <> invalid and m.item.Type = "Series"
            loadEpisodes(m.seasonId)
            m.episodeList.setFocus(true)
        else
            if m.item <> invalid and m.item.UserData <> invalid and done then m.item.UserData.Played = true
            setPlayButtons()
        end if
    end if
end sub

' ---------- The Back button ----------

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.tourOn = true then return tourKey(key)
    if m.video.visible
        if key = "back"
            finishPlayback(false)
            return true
        end if
        return false
    end if
    if key = "back"
        if m.stack.count() > 0
            prev = m.stack.pop()
            show(prev)
            if prev = "homeView" then m.rowList.setFocus(true)
            if prev = "gridView" then m.grid.setFocus(true)
            return true
        end if
        return false
    end if
    if key = "options" and m.view = "detailsView"
        if m.episodeList.hasFocus() then toggleEpisode()
        if m.seasonList.hasFocus() then markSeason()
        return true
    end if
    return false
end function
