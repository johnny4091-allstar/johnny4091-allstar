' Plays a title with Roku's own player. Tells Emby where you are (so Continue Watching is right on every device) and plays the next episode.
sub init()
  m.video = m.top.findNode("video")
  m.message = m.top.findNode("message")
  m.timer = m.top.findNode("progressTimer")
  m.video.observeField("state", "onState")
  m.timer.observeField("fire", "onTick")
  m.source = invalid
  m.reportedStart = false
  m.closing = false
end sub

sub start()
  m.video.setFocus(true)
  req = m.top.request
  m.current = req
  open(req)
end sub

sub resume()
end sub

function deviceProfile() as Object
  return {
    Name: "Aurora Roku",
    MaxStreamingBitrate: 40000000,
    MaxStaticBitrate: 80000000,
    DirectPlayProfiles: [
      { Container: "mp4,m4v,mov,mkv", Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3,mp3,flac" }
    ],
    TranscodingProfiles: [
      { Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3,eac3", Protocol: "hls", Context: "Streaming", MaxAudioChannels: "6", MinSegments: "1", BreakOnNonKeyFrames: true }
    ],
    CodecProfiles: [
      { Type: "Video", Codec: "h264", Conditions: [{ Condition: "LessThanEqual", Property: "VideoLevel", Value: "42", IsRequired: false }] }
    ],
    SubtitleProfiles: [
      { Format: "srt", Method: "Encode" }, { Format: "ass", Method: "Encode" }, { Format: "ssa", Method: "Encode" },
      { Format: "pgssub", Method: "Encode" }, { Format: "dvdsub", Method: "Encode" }, { Format: "dvbsub", Method: "Encode" }, { Format: "vtt", Method: "Encode" }
    ]
  }
end function

sub open(req as Object)
  m.current = req
  m.source = invalid
  m.reportedStart = false
  m.message.text = "Starting..."
  m.message.visible = true
  ticks = 0
  if req.startTicks <> invalid then ticks = req.startTicks
  m.startTicks = ticks
  CallApi({
    path: "/Items/" + req.id + "/PlaybackInfo", method: "POST",
    query: { UserId: m.global.userId, StartTimeTicks: Seconds(ticks).ToStr() + "0000000", IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: 40000000 },
    body: { DeviceProfile: deviceProfile() }, tag: "info"
  }, "onInfo")
end sub

sub onInfo(event as Object)
  r = event.getData()
  if not r.ok or r.json = invalid or r.json.MediaSources = invalid or r.json.MediaSources.Count() = 0
    fail("This can't be played right now (" + r.status.ToStr() + ").")
    return
  end if
  src = r.json.MediaSources[0]
  session = r.json.PlaySessionId
  if session = invalid then session = ""
  g = m.global
  url = ""
  method = "Transcode"
  format = "hls"
  if src.SupportsDirectPlay = true
    url = g.server + "/emby/Videos/" + m.current.id + "/stream?Static=true&MediaSourceId=" + src.Id + "&api_key=" + g.token + "&DeviceId=" + g.deviceId + "&PlaySessionId=" + session
    method = "DirectPlay"
    format = StreamFormat(src.Container)
  else if src.TranscodingUrl <> invalid
    path = src.TranscodingUrl
    if Left(path, 4) = "http"
      url = path
    else if Left(path, 5) = "/emby"
      url = g.server + path
    else
      url = g.server + "/emby" + path
    end if
    if Instr(1, url, "api_key=") = 0 then url = url + "&api_key=" + g.token
    format = "hls"
  end if
  if url = ""
    fail("Aurora could not find a way to play this on a Roku.")
    return
  end if
  m.source = { id: src.Id, session: session, method: method }
  content = CreateObject("roSGNode", "ContentNode")
  content.url = url
  content.streamFormat = format
  content.title = m.current.title
  if m.startTicks > 0 then content.PlayStart = Seconds(m.startTicks)
  m.video.content = content
  m.video.control = "play"
end sub

function StreamFormat(container as Dynamic) as String
  if container = invalid then return "mp4"
  c = LCase(container)
  if Instr(1, c, "mkv") > 0 or Instr(1, c, "matroska") > 0 then return "mkv"
  if Instr(1, c, "ts") > 0 and Instr(1, c, "mp4") = 0 then return "ts"
  return "mp4"
end function

sub onState()
  state = m.video.state
  if state = "playing"
    m.message.visible = false
    if not m.reportedStart
      m.reportedStart = true
      report("/Sessions/Playing", false)
    end if
    m.timer.control = "start"
  else if state = "buffering"
    m.message.text = "Loading..."
    m.message.visible = true
  else if state = "paused"
    report("/Sessions/Playing/Progress", true)
  else if state = "finished"
    m.timer.control = "stop"
    report("/Sessions/Playing/Stopped", false)
    playNextOrClose()
  else if state = "error"
    m.timer.control = "stop"
    fail("This can't be played on this Roku. Try another title.")
  end if
end sub

sub onTick()
  if m.video.state = "playing" then report("/Sessions/Playing/Progress", false)
end sub

sub report(path as String, paused as Boolean)
  if m.source = invalid then return
  secs = Int(m.video.position)
  body = { ItemId: m.current.id, MediaSourceId: m.source.id, PlaySessionId: m.source.session, PlayMethod: m.source.method, PositionTicks: secs * 10000000&, CanSeek: true, IsPaused: paused }
  CallApi({ path: path, method: "POST", body: body, tag: "report" }, "onReported")
end sub

sub onReported(event as Object)
end sub

sub playNextOrClose()
  req = m.current
  if req.itemType = "Episode" and req.seriesId <> invalid and req.seriesId <> ""
    CallApi({ path: "/Shows/" + req.seriesId + "/Episodes", query: { UserId: m.global.userId, StartItemId: req.id, Limit: 2, Fields: "Overview" }, tag: "next" }, "onNextEpisode")
  else
    closeNow()
  end if
end sub

sub onNextEpisode(event as Object)
  r = event.getData()
  if r.ok and r.json <> invalid and r.json.Items <> invalid and r.json.Items.Count() > 1
    nx = r.json.Items[1]
    open({ id: nx.Id, startTicks: 0, title: nx.SeriesName + " - " + nx.Name, itemType: "Episode", seriesId: nx.SeriesId })
  else
    closeNow()
  end if
end sub

sub fail(text as String)
  m.message.text = text + "  (Press Back)"
  m.message.visible = true
  m.failed = true
end sub

sub closeNow()
  if m.closing then return
  m.closing = true
  m.timer.control = "stop"
  m.video.control = "stop"
  m.top.close = true
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if press and key = "back"
    if m.source <> invalid and m.reportedStart then report("/Sessions/Playing/Stopped", false)
    closeNow()
    return true
  end if
  return false
end function
