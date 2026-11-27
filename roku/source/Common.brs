' Shared helpers. Every component that needs them includes this file.

function AuroraServerDefault() as String
  return "https://emby4836.duckdns.org:8920"
end function

function AuroraGuardDefault() as String
  return "https://emby4836.duckdns.org:8922"
end function

' ----- Saved settings (the Roku keeps them between runs) -----
function RegGet(key as String, fallback as String) as String
  sec = CreateObject("roRegistrySection", "aurora")
  if sec.Exists(key) then return sec.Read(key)
  return fallback
end function

sub RegSet(key as String, value as String)
  sec = CreateObject("roRegistrySection", "aurora")
  sec.Write(key, value)
  sec.Flush()
end sub

sub RegDelete(key as String)
  sec = CreateObject("roRegistrySection", "aurora")
  if sec.Exists(key) then sec.Delete(key)
  sec.Flush()
end sub

' ----- Talking to Emby (and, later, the Aurora Guard) -----
' request: { path, query, method, body, base ("emby" or "guard"), tag }. When it finishes, the function named in callback is called with an
' event whose data is { ok, status, json, text, tag }.
function CallApi(request as Object, callback as String) as Object
  task = CreateObject("roSGNode", "ApiTask")
  task.request = request
  task.observeField("response", callback)
  if m.apiTasks = invalid then m.apiTasks = []
  if m.apiTasks.Count() > 24
    keep = []
    for each t in m.apiTasks
      if t.state <> "stop" then keep.Push(t)
    end for
    m.apiTasks = keep
  end if
  m.apiTasks.Push(task)
  task.control = "RUN"
  return task
end function

function UserPath(suffix as String) as String
  return "/Users/" + m.global.userId + suffix
end function

function ImageUrl(id as String, kind as String, height as Integer, tag as Dynamic) as String
  url = m.global.server + "/emby/Items/" + id + "/Images/" + kind + "?maxHeight=" + height.ToStr() + "&quality=90"
  if tag <> invalid and tag <> "" then url = url + "&tag=" + tag
  return url
end function

' ----- Showing items -----
function Seconds(ticks as Dynamic) as Integer
  if ticks = invalid then return 0
  return Int(ticks / 10000000)
end function

function RuntimeText(ticks as Dynamic) as String
  minutes = Int(Seconds(ticks) / 60)
  if minutes <= 0 then return ""
  if minutes < 60 then return minutes.ToStr() + " min"
  return Int(minutes / 60).ToStr() + " h " + (minutes mod 60).ToStr() + " min"
end function

function ClockText(totalSeconds as Integer) as String
  h = Int(totalSeconds / 3600)
  mn = Int((totalSeconds mod 3600) / 60)
  s = totalSeconds mod 60
  out = ""
  if h > 0 then out = h.ToStr() + ":"
  if mn < 10 and h > 0 then out = out + "0"
  out = out + mn.ToStr() + ":"
  if s < 10 then out = out + "0"
  return out + s.ToStr()
end function

' Turns Emby items into a list of content nodes the poster rows and grids understand.
function ItemsToContent(items as Object) as Object
  root = CreateObject("roSGNode", "ContentNode")
  if items = invalid then return root
  for each it in items
    root.appendChild(ItemToNode(it))
  end for
  return root
end function

function ItemToNode(it as Object) as Object
  node = CreateObject("roSGNode", "ContentNode")
  title = it.Name
  if it.Type = "Episode" and it.SeriesName <> invalid then
    title = it.SeriesName
    if it.ParentIndexNumber <> invalid and it.IndexNumber <> invalid then title = title + "  S" + it.ParentIndexNumber.ToStr() + ":E" + it.IndexNumber.ToStr()
  end if
  node.title = title
  node.id = it.Id
  node.description = ""
  if it.Overview <> invalid then node.description = it.Overview
  node.Length = Seconds(it.RunTimeTicks)
  if it.UserData <> invalid and it.UserData.PlaybackPositionTicks <> invalid then node.PlayStart = Seconds(it.UserData.PlaybackPositionTicks)
  ' The picture: a show's or movie's poster; an episode shows its own still.
  tag = invalid
  if it.ImageTags <> invalid then tag = it.ImageTags.Primary
  poster = ImageUrl(it.Id, "Primary", 420, tag)
  if tag = invalid and it.SeriesId <> invalid then poster = ImageUrl(it.SeriesId, "Primary", 420, invalid)
  node.HDPosterUrl = poster
  node.addFields({ embyType: it.Type, embyId: it.Id })
  return node
end function

' A short description for a details line: year, rating, runtime.
function MetaLine(it as Object) as String
  parts = []
  if it.ProductionYear <> invalid then parts.Push(it.ProductionYear.ToStr())
  if it.OfficialRating <> invalid then parts.Push(it.OfficialRating)
  rt = RuntimeText(it.RunTimeTicks)
  if rt <> "" then parts.Push(rt)
  if it.CommunityRating <> invalid then parts.Push(Left(it.CommunityRating.ToStr(), 3) + " / 10")
  out = ""
  for each p in parts
    if out <> "" then out = out + "   .   "
    out = out + p
  end for
  return out
end function

' The fields every list asks Emby for.
function ItemFields() as String
  return "Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,PrimaryImageAspectRatio,DateCreated"
end function

' BrightScript has no Trim: cut spaces off both ends.
function TrimText(text as String) as String
  s = text
  while Len(s) > 0 and Left(s, 1) = " "
    s = Mid(s, 2)
  end while
  while Len(s) > 0 and Right(s, 1) = " "
    s = Left(s, Len(s) - 1)
  end while
  return s
end function
