' The window the whole app lives in: a top menu, one page at a time under it, and full-screen layers (sign in, a title's page, the player) on top.
sub init()
  m.navNames = ["Home", "Movies", "TV Shows", "Search", "Favorites", "Settings"]
  m.navIndex = 0
  m.pages = {}
  m.layers = []
  m.area = "nav"
  m.navLabels = []
  m.navPos = []
  m.navHi = m.top.findNode("navHi")
  m.pageHost = m.top.findNode("pageHost")
  m.shell = m.top.findNode("shell")
  m.overlay = m.top.findNode("overlay")
  x = 0
  host = m.top.findNode("navItems")
  for i = 0 to m.navNames.Count() - 1
    lbl = CreateObject("roSGNode", "Label")
    lbl.text = m.navNames[i]
    lbl.font = "font:MediumSystemFont"
    lbl.color = "0xB9C3EAFF"
    lbl.translation = [x, 0]
    host.appendChild(lbl)
    m.navLabels.Push(lbl)
    w = lbl.boundingRect().width
    if w < 10 then w = Len(m.navNames[i]) * 20 ' not measured yet: a fair guess
    m.navPos.Push({ x: x, w: w })
    x = x + w + 70
  end for
  m.shell.visible = false
  if m.global.token <> "" and m.global.userId <> ""
    ' Check the saved sign-in is still good before showing anything.
    CallApi({ path: UserPath(""), tag: "check" }, "onCheck")
  else
    showLogin()
  end if
end sub

sub onCheck(event as Object)
  r = event.getData()
  if r.ok
    startShell()
  else
    signOut()
  end if
end sub

sub showLogin()
  m.shell.visible = false
  login = CreateObject("roSGNode", "LoginScreen")
  login.observeField("signedIn", "onSignedIn")
  pushLayer(login)
end sub

sub onSignedIn(event as Object)
  popLayer()
  startShell()
end sub

sub startShell()
  m.shell.visible = true
  m.navIndex = 0
  showPage(0)
  focusNav()
end sub

sub signOut()
  RegDelete("token")
  RegDelete("userId")
  RegDelete("userName")
  m.global.token = ""
  m.global.userId = ""
  m.global.userName = ""
  ' Forget everything that belonged to the last person.
  for each key in m.pages
    m.pageHost.removeChild(m.pages[key])
  end for
  m.pages = {}
  while m.layers.Count() > 0
    popLayer()
  end while
  showLogin()
end sub

' ----- The menu and the pages -----
function pageName(index as Integer) as String
  return ["HomePage", "BrowsePage", "BrowsePage", "SearchPage", "BrowsePage", "SettingsPage"][index]
end function

sub showPage(index as Integer)
  m.navIndex = index
  for each key in m.pages
    m.pages[key].visible = false
  end for
  key = index.ToStr()
  if not m.pages.DoesExist(key)
    page = CreateObject("roSGNode", pageName(index))
    if index = 1 then page.kind = "Movie"
    if index = 2 then page.kind = "Series"
    if index = 4 then page.kind = "Favorites"
    page.observeField("itemSelected", "onItemSelected")
    page.observeField("signOutRequested", "onSignOutRequested")
    m.pageHost.appendChild(page)
    m.pages[key] = page
  end if
  m.pages[key].visible = true
  paintNav()
end sub

sub paintNav()
  for i = 0 to m.navLabels.Count() - 1
    if i = m.navIndex
      m.navLabels[i].color = "0xFFFFFFFF"
    else
      m.navLabels[i].color = "0xB9C3EAFF"
    end if
  end for
  spot = m.navPos[m.navIndex]
  host = m.top.findNode("navItems")
  t = host.translation
  m.navHi.translation = [t[0] + spot.x - 24, t[1] - 10]
  m.navHi.width = spot.w + 48
  m.navHi.height = 60
  m.navHi.visible = (m.area = "nav")
end sub

sub focusNav()
  m.area = "nav"
  m.top.setFocus(true)
  paintNav()
end sub

sub focusPage()
  page = m.pages[m.navIndex.ToStr()]
  if page <> invalid
    m.area = "page"
    page.callFunc("focusContent")
    paintNav()
  end if
end sub

' ----- Layers on top: a title's page, the player, sign in -----
sub pushLayer(node as Object)
  m.layers.Push(node)
  m.shell.visible = false
  node.observeField("close", "onLayerClose")
  node.observeField("openItem", "onOpenItem")
  node.observeField("playRequest", "onPlayRequest")
  node.observeField("signOutRequested", "onSignOutRequested")
  m.overlay.appendChild(node)
  m.area = "layer"
  node.setFocus(true)
  node.callFunc("start")
end sub

sub popLayer()
  if m.layers.Count() = 0 then return
  node = m.layers.Pop()
  m.overlay.removeChild(node)
  if m.layers.Count() > 0
    top = m.layers[m.layers.Count() - 1]
    top.setFocus(true)
    top.callFunc("resume")
  else if m.global.token <> ""
    m.shell.visible = true
    m.area = "page"
    ' What was watched changes Continue Watching and the progress bars: the pages refresh quietly.
    for each key in m.pages
      m.pages[key].callFunc("refresh")
    end for
    focusPage()
  end if
end sub

sub onLayerClose(event as Object)
  popLayer()
end sub

sub onItemSelected(event as Object)
  d = event.getData()
  openItem(d)
end sub

sub onOpenItem(event as Object)
  openItem(event.getData())
end sub

sub openItem(d as Object)
  if d = invalid or d.id = invalid then return
  screen = CreateObject("roSGNode", "DetailsScreen")
  screen.itemId = d.id
  screen.itemType = d.type
  pushLayer(screen)
end sub

sub onPlayRequest(event as Object)
  req = event.getData()
  player = CreateObject("roSGNode", "PlayerScreen")
  player.request = req
  pushLayer(player)
end sub

sub onSignOutRequested(event as Object)
  signOut()
end sub

' ----- Keys that no page or layer used -----
function onKeyEvent(key as String, press as Boolean) as Boolean
  if not press then return false
  if m.area = "nav"
    if key = "left"
      if m.navIndex > 0 then showPage(m.navIndex - 1)
      return true
    else if key = "right"
      if m.navIndex < m.navNames.Count() - 1 then showPage(m.navIndex + 1)
      return true
    else if key = "down" or key = "OK"
      focusPage()
      return true
    end if
    return false ' Back on the menu leaves Aurora
  else if m.area = "page"
    if key = "up" or key = "back"
      focusNav()
      return true
    end if
  end if
  return false
end function
