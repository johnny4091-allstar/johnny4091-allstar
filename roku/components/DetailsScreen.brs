' A movie, a show or an episode: the story, Play or Resume, favorites, watched, and for a show its seasons and episodes.
sub init()
  m.buttons = m.top.findNode("buttons")
  m.seasons = m.top.findNode("seasons")
  m.episodes = m.top.findNode("episodes")
  m.item = invalid
  m.actions = []
  m.episodeItems = []
  m.seasonItems = []
  m.nextUp = invalid
  m.buttons.observeField("buttonSelected", "onButton")
  m.seasons.observeField("itemFocused", "onSeasonFocused")
  m.episodes.observeField("itemSelected", "onEpisode")
end sub

sub start()
  load()
  m.top.setFocus(true)
end sub

sub resume()
  ' Back from the player: what was watched may have changed.
  load()
end sub

sub load()
  CallApi({ path: UserPath("/Items/" + m.top.itemId), query: { Fields: ItemFields() + ",People,Taglines" }, tag: "item" }, "onItem")
end sub

sub onItem(event as Object)
  r = event.getData()
  if not r.ok or r.json = invalid
    m.top.findNode("status").text = "Could not open this (" + r.status.ToStr() + "). Press Back."
    return
  end if
  m.item = r.json
  it = m.item
  m.top.findNode("status").visible = false
  title = it.Name
  if it.Type = "Episode" and it.SeriesName <> invalid then title = it.SeriesName + "  -  " + it.Name
  m.top.findNode("title").text = title
  meta = MetaLine(it)
  if it.Type = "Episode" and it.ParentIndexNumber <> invalid and it.IndexNumber <> invalid then meta = "Season " + it.ParentIndexNumber.ToStr() + ", episode " + it.IndexNumber.ToStr() + "   .   " + meta
  m.top.findNode("meta").text = meta
  overview = ""
  if it.Overview <> invalid then overview = it.Overview
  m.top.findNode("overview").text = overview
  tag = invalid
  if it.ImageTags <> invalid then tag = it.ImageTags.Primary
  m.top.findNode("poster").uri = ImageUrl(it.Id, "Primary", 700, tag)
  if it.BackdropImageTags <> invalid and it.BackdropImageTags.Count() > 0
    m.top.findNode("backdrop").uri = ImageUrl(it.Id, "Backdrop", 1080, it.BackdropImageTags[0])
  end if
  if it.Type = "Series"
    CallApi({ path: "/Shows/NextUp", query: { SeriesId: it.Id, UserId: m.global.userId, Limit: 1, Fields: ItemFields() }, tag: "nextUp" }, "onNextUp")
    CallApi({ path: "/Shows/" + it.Id + "/Seasons", query: { UserId: m.global.userId, Fields: "ItemCounts" }, tag: "seasons" }, "onSeasons")
  end if
  paintButtons()
end sub

sub paintButtons()
  it = m.item
  m.actions = []
  labels = []
  resumeAt = 0
  if it.UserData <> invalid and it.UserData.PlaybackPositionTicks <> invalid then resumeAt = Seconds(it.UserData.PlaybackPositionTicks)
  if it.Type = "Series"
    if m.nextUp <> invalid
      labels.Push("Play " + EpisodeLabel(m.nextUp))
      m.actions.Push("playNext")
    else
      labels.Push("Play")
      m.actions.Push("playFirst")
    end if
  else
    if resumeAt > 30
      labels.Push("Resume  " + ClockText(resumeAt))
      m.actions.Push("resume")
      labels.Push("Start over")
      m.actions.Push("play")
    else
      labels.Push("Play")
      m.actions.Push("play")
    end if
  end if
  fav = false
  played = false
  if it.UserData <> invalid
    if it.UserData.IsFavorite = true then fav = true
    if it.UserData.Played = true then played = true
  end if
  if fav then labels.Push("Remove from Favorites") else labels.Push("Add to Favorites")
  m.actions.Push("favorite")
  if played then labels.Push("Mark unwatched") else labels.Push("Mark watched")
  m.actions.Push("played")
  focused = m.buttons.hasFocus()
  m.buttons.buttons = labels
  if m.top.isInFocusChain() and not m.seasons.hasFocus() and not m.episodes.hasFocus() then m.buttons.setFocus(true)
end sub

function EpisodeLabel(ep as Object) as String
  if ep.ParentIndexNumber <> invalid and ep.IndexNumber <> invalid then return "S" + ep.ParentIndexNumber.ToStr() + ":E" + ep.IndexNumber.ToStr()
  return ep.Name
end function

sub onNextUp(event as Object)
  r = event.getData()
  if r.ok and r.json <> invalid and r.json.Items <> invalid and r.json.Items.Count() > 0
    m.nextUp = r.json.Items[0]
    if m.item <> invalid then paintButtons()
  end if
end sub

sub onButton(event as Object)
  act = m.actions[event.getData()]
  it = m.item
  if act = "play" or act = "playFirst"
    play(it.Id, 0, it)
  else if act = "resume"
    play(it.Id, it.UserData.PlaybackPositionTicks, it)
  else if act = "playNext"
    ticks = 0
    if m.nextUp.UserData <> invalid and m.nextUp.UserData.PlaybackPositionTicks <> invalid then ticks = m.nextUp.UserData.PlaybackPositionTicks
    play(m.nextUp.Id, ticks, m.nextUp)
  else if act = "favorite"
    method = "POST"
    if it.UserData <> invalid and it.UserData.IsFavorite = true then method = "DELETE"
    CallApi({ path: UserPath("/FavoriteItems/" + it.Id), method: method, tag: "toggle" }, "onToggled")
  else if act = "played"
    method = "POST"
    if it.UserData <> invalid and it.UserData.Played = true then method = "DELETE"
    CallApi({ path: UserPath("/PlayedItems/" + it.Id), method: method, tag: "toggle" }, "onToggled")
  end if
end sub

sub onToggled(event as Object)
  load()
end sub

sub play(id as String, startTicks as Dynamic, it as Object)
  if startTicks = invalid then startTicks = 0
  m.top.playRequest = { id: id, startTicks: startTicks, title: it.Name, itemType: it.Type, seriesId: it.SeriesId }
end sub

' ----- Seasons and episodes of a show -----
sub onSeasons(event as Object)
  r = event.getData()
  if not r.ok or r.json = invalid or r.json.Items = invalid then return
  m.seasonItems = r.json.Items
  root = CreateObject("roSGNode", "ContentNode")
  for each s in m.seasonItems
    n = root.createChild("ContentNode")
    n.title = s.Name
  end for
  m.seasons.content = root
  m.top.findNode("seasonsTitle").visible = true
  m.seasons.visible = true
  m.top.findNode("episodesTitle").visible = true
  m.episodes.visible = true
  if m.seasonItems.Count() > 0 then loadEpisodes(0)
end sub

sub onSeasonFocused(event as Object)
  idx = event.getData()
  if idx >= 0 and idx < m.seasonItems.Count() then loadEpisodes(idx)
end sub

sub loadEpisodes(idx as Integer)
  if m.item = invalid then return
  m.shownSeason = idx
  CallApi({ path: "/Shows/" + m.item.Id + "/Episodes", query: { UserId: m.global.userId, SeasonId: m.seasonItems[idx].Id, Fields: "Overview,RunTimeTicks" }, tag: idx.ToStr() }, "onEpisodes")
end sub

sub onEpisodes(event as Object)
  r = event.getData()
  if r.tag <> m.shownSeason.ToStr() then return
  if not r.ok or r.json = invalid or r.json.Items = invalid then return
  m.episodeItems = r.json.Items
  root = CreateObject("roSGNode", "ContentNode")
  for each e in m.episodeItems
    n = root.createChild("ContentNode")
    num = ""
    if e.IndexNumber <> invalid then num = e.IndexNumber.ToStr() + ".  "
    line = num + e.Name
    rt = RuntimeText(e.RunTimeTicks)
    if rt <> "" then line = line + "   (" + rt + ")"
    if e.UserData <> invalid and e.UserData.Played = true then line = line + "   - watched"
    n.title = line
  end for
  m.episodes.content = root
end sub

sub onEpisode(event as Object)
  e = m.episodeItems[event.getData()]
  if e = invalid then return
  ticks = 0
  if e.UserData <> invalid and e.UserData.PlaybackPositionTicks <> invalid then ticks = e.UserData.PlaybackPositionTicks
  play(e.Id, ticks, e)
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if not press then return false
  if key = "back"
    m.top.close = true
    return true
  end if
  hasSeasons = m.seasons.visible
  if key = "down" and m.buttons.hasFocus() and hasSeasons
    m.seasons.setFocus(true)
    return true
  else if key = "up" and (m.seasons.hasFocus() or m.episodes.hasFocus())
    m.buttons.setFocus(true)
    return true
  else if key = "right" and m.seasons.hasFocus()
    m.episodes.setFocus(true)
    return true
  else if key = "left" and m.episodes.hasFocus()
    m.seasons.setFocus(true)
    return true
  end if
  return false
end function
