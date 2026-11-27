' Movies, TV Shows and Favorites as a grid of posters, with sorting (press * on the remote) and more loading as you go down.
sub init()
  m.grid = m.top.findNode("grid")
  m.status = m.top.findNode("status")
  m.sortLabel = m.top.findNode("sortLabel")
  m.grid.observeField("itemSelected", "onSelect")
  m.grid.observeField("itemFocused", "onFocused")
  m.sorts = [
    { name: "A to Z", by: "SortName", order: "Ascending" },
    { name: "Recently added", by: "DateCreated", order: "Descending" },
    { name: "Top rated", by: "CommunityRating", order: "Descending" }
  ]
  m.sortIndex = 0
  m.total = 0
  m.loading = false
  m.content = invalid
  m.generation = 0
end sub

sub onKind()
  m.kind = m.top.kind
  reload()
end sub

sub reload()
  m.generation = m.generation + 1
  m.content = CreateObject("roSGNode", "ContentNode")
  m.total = 0
  m.loading = false
  m.status.text = "Loading..."
  m.status.visible = true
  m.grid.visible = false
  paintSort()
  loadMore()
end sub

sub refresh()
  ' Quietly bring the first page up to date (progress bars, new favorites).
  if m.content <> invalid and m.content.getChildCount() > 0 and m.kind = "Favorites" then reload()
end sub

sub paintSort()
  s = m.sorts[m.sortIndex]
  title = "Movies"
  if m.kind = "Series" then title = "TV Shows"
  if m.kind = "Favorites" then title = "Favorites"
  m.sortLabel.text = title + "   -   " + s.name + "   -   press * to change the order"
end sub

sub loadMore()
  if m.loading then return
  if m.total > 0 and m.content.getChildCount() >= m.total then return
  m.loading = true
  s = m.sorts[m.sortIndex]
  q = { Recursive: true, SortBy: s.by, SortOrder: s.order, StartIndex: m.content.getChildCount(), Limit: 60, Fields: ItemFields(), ImageTypeLimit: 1 }
  if m.kind = "Favorites"
    q.IncludeItemTypes = "Movie,Series"
    q.Filters = "IsFavorite"
  else
    q.IncludeItemTypes = m.kind
  end if
  CallApi({ path: UserPath("/Items"), query: q, tag: m.generation.ToStr() }, "onPage")
end sub

sub onPage(event as Object)
  r = event.getData()
  if r.tag <> m.generation.ToStr() then return ' an old answer, from before the order changed
  m.loading = false
  if not r.ok or r.json = invalid
    m.status.text = "Could not load this list (" + r.status.ToStr() + "). Press Up and try again."
    return
  end if
  m.total = r.json.TotalRecordCount
  for each it in r.json.Items
    m.content.appendChild(ItemToNode(it))
  end for
  if m.content.getChildCount() = 0
    m.status.text = "Nothing here yet."
    m.grid.visible = false
    return
  end if
  m.status.visible = false
  focused = m.grid.hasFocus()
  keep = m.grid.itemFocused
  m.grid.content = m.content
  m.grid.visible = true
  if keep <> invalid and keep > 0 and keep < m.content.getChildCount() then m.grid.jumpToItem = keep
  if focused then m.grid.setFocus(true)
end sub

sub onFocused(event as Object)
  idx = event.getData()
  if m.content <> invalid and idx >= m.content.getChildCount() - 14 then loadMore()
end sub

sub onSelect(event as Object)
  node = m.content.getChild(event.getData())
  if node <> invalid then m.top.itemSelected = { id: node.embyId, type: node.embyType }
end sub

sub focusContent()
  if m.grid.visible then m.grid.setFocus(true) else m.top.setFocus(true)
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if press and key = "options" and m.kind <> "Favorites"
    m.sortIndex = (m.sortIndex + 1) mod m.sorts.Count()
    reload()
    return true
  end if
  return false
end function
