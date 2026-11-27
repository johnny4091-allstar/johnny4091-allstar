' Home: Continue Watching, Next Up, and the newest movies and shows.
sub init()
  m.rows = m.top.findNode("rows")
  m.status = m.top.findNode("status")
  m.rows.observeField("rowItemSelected", "onSelect")
  m.data = { resume: invalid, nextUp: invalid, movies: invalid, shows: invalid }
  m.loaded = false
  load()
end sub

sub load()
  fields = ItemFields()
  CallApi({ path: UserPath("/Items/Resume"), query: { Limit: 20, MediaTypes: "Video", Recursive: true, Fields: fields, ImageTypeLimit: 1 }, tag: "resume" }, "onData")
  CallApi({ path: "/Shows/NextUp", query: { UserId: m.global.userId, Limit: 20, Fields: fields, ImageTypeLimit: 1 }, tag: "nextUp" }, "onData")
  CallApi({ path: UserPath("/Items/Latest"), query: { IncludeItemTypes: "Movie", Limit: 24, Fields: fields, ImageTypeLimit: 1 }, tag: "movies" }, "onData")
  CallApi({ path: UserPath("/Items/Latest"), query: { IncludeItemTypes: "Series", Limit: 24, Fields: fields, ImageTypeLimit: 1 }, tag: "shows" }, "onData")
end sub

sub refresh()
  if m.loaded then load()
end sub

sub onData(event as Object)
  r = event.getData()
  items = []
  if r.ok and r.json <> invalid
    ' Resume and NextUp answer { Items: [...] }; Latest answers a plain list.
    if Type(r.json) = "roArray"
      items = r.json
    else if r.json.Items <> invalid
      items = r.json.Items
    end if
  else if r.tag = "resume" and not r.ok
    m.status.text = "Could not reach Aurora (" + r.status.ToStr() + "). Check your internet and try again."
  end if
  m.data[r.tag] = items
  if m.data.resume <> invalid and m.data.nextUp <> invalid and m.data.movies <> invalid and m.data.shows <> invalid then paint()
end sub

sub paint()
  root = CreateObject("roSGNode", "ContentNode")
  heights = []
  sizes = []
  spacing = []
  labels = []
  for each spec in [{ key: "resume", title: "Continue Watching" }, { key: "nextUp", title: "Next Up" }, { key: "movies", title: "Recently Added Movies" }, { key: "shows", title: "Recently Added TV Shows" }]
    list = m.data[spec.key]
    if list.Count() > 0
      row = ItemsToContent(list)
      row.title = spec.title
      root.appendChild(row)
      heights.Push(420)
      sizes.Push([240, 420])
      spacing.Push([28, 0])
      labels.Push(true)
    end if
  end for
  if root.getChildCount() = 0
    if m.status.text = "Loading..." then m.status.text = "Nothing here yet. Add some movies or shows to your library and they will show up."
    m.rows.visible = false
    m.status.visible = true
    return
  end if
  m.status.visible = false
  m.loaded = true
  focused = m.rows.hasFocus()
  keepRow = m.rows.rowItemFocused
  m.rows.rowHeights = heights
  m.rows.rowItemSize = sizes
  m.rows.rowItemSpacing = spacing
  m.rows.showRowLabel = labels
  m.rows.content = root
  m.rows.visible = true
  if keepRow <> invalid and keepRow[0] < root.getChildCount() then m.rows.jumpToRowItem = keepRow
  m.data = { resume: invalid, nextUp: invalid, movies: invalid, shows: invalid }
  if focused then m.rows.setFocus(true)
end sub

sub onSelect(event as Object)
  at = event.getData()
  row = m.rows.content.getChild(at[0])
  if row = invalid then return
  node = row.getChild(at[1])
  if node = invalid then return
  m.top.itemSelected = { id: node.embyId, type: node.embyType }
end sub

sub focusContent()
  if m.rows.visible then m.rows.setFocus(true) else m.top.setFocus(true)
end sub
