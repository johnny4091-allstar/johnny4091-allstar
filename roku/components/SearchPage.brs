' Search: a keyboard on the left, the matches on the right.
sub init()
  m.keyboard = m.top.findNode("keyboard")
  m.grid = m.top.findNode("grid")
  m.status = m.top.findNode("status")
  m.timer = m.top.findNode("debounce")
  m.generation = 0
  m.content = invalid
  m.keyboard.observeField("text", "onText")
  m.timer.observeField("fire", "onFire")
  m.grid.observeField("itemSelected", "onSelect")
end sub

sub onText()
  m.timer.control = "stop"
  m.timer.control = "start"
end sub

sub onFire()
  term = m.keyboard.text
  m.generation = m.generation + 1
  if Len(term) < 2
    m.grid.visible = false
    m.status.text = ""
    return
  end if
  m.status.text = "Searching..."
  CallApi({ path: UserPath("/Items"), query: { SearchTerm: term, IncludeItemTypes: "Movie,Series", Recursive: true, Limit: 40, Fields: ItemFields(), ImageTypeLimit: 1 }, tag: m.generation.ToStr() }, "onResults")
end sub

sub onResults(event as Object)
  r = event.getData()
  if r.tag <> m.generation.ToStr() then return
  if not r.ok or r.json = invalid
    m.status.text = "Search did not work. Try again."
    return
  end if
  m.content = ItemsToContent(r.json.Items)
  if m.content.getChildCount() = 0
    m.status.text = "No matches."
    m.grid.visible = false
    return
  end if
  m.status.text = ""
  m.grid.content = m.content
  m.grid.visible = true
end sub

sub onSelect(event as Object)
  node = m.content.getChild(event.getData())
  if node <> invalid then m.top.itemSelected = { id: node.embyId, type: node.embyType }
end sub

sub refresh()
end sub

sub focusContent()
  m.keyboard.setFocus(true)
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
  if not press then return false
  if key = "right" and m.keyboard.hasFocus() and m.grid.visible
    m.grid.setFocus(true)
    return true
  else if key = "left" and m.grid.hasFocus()
    m.keyboard.setFocus(true)
    return true
  end if
  return false
end function
