' Sign in: the server (filled in), a username and a password, each typed on the Roku's own keyboard.
sub init()
  m.buttons = m.top.findNode("buttons")
  m.message = m.top.findNode("message")
  m.server = m.global.server
  m.user = RegGet("lastUser", "")
  m.pass = ""
  m.busy = false
  m.buttons.observeField("buttonSelected", "onButton")
  paint()
end sub

sub start()
  m.buttons.setFocus(true)
end sub

sub resume()
  m.buttons.setFocus(true)
end sub

sub paint()
  pw = ""
  if Len(m.pass) > 0 then pw = String(Len(m.pass), "*")
  u = m.user
  if u = "" then u = "(not set)"
  p = pw
  if p = "" then p = "(not set)"
  m.buttons.buttons = ["Username:  " + u, "Password:  " + p, "Sign in", "Server:  " + m.server]
end sub

sub onButton(event as Object)
  if m.busy then return
  i = event.getData()
  if i = 0
    ask("Username", m.user, false, "onUser")
  else if i = 1
    ask("Password", "", true, "onPass")
  else if i = 2
    signIn()
  else if i = 3
    ask("Server address", m.server, false, "onServer")
  end if
end sub

sub ask(title as String, current as String, secret as Boolean, callback as String)
  dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
  dlg.title = title
  dlg.text = current
  dlg.buttons = ["OK", "Cancel"]
  if secret then dlg.keyboard.textEditBox.secureMode = true
  dlg.observeFieldScoped("buttonSelected", callback)
  m.dlg = dlg
  m.top.getScene().dialog = dlg
end sub

sub closeDialog()
  m.top.getScene().dialog = invalid
  m.buttons.setFocus(true)
end sub

sub onUser(event as Object)
  if event.getData() = 0 then m.user = TrimText(m.dlg.text)
  closeDialog()
  paint()
end sub

sub onPass(event as Object)
  if event.getData() = 0 then m.pass = m.dlg.text
  closeDialog()
  paint()
end sub

sub onServer(event as Object)
  if event.getData() = 0
    s = TrimText(m.dlg.text)
    if s <> ""
      if Left(LCase(s), 4) <> "http" then s = "https://" + s
      while Right(s, 1) = "/"
        s = Left(s, Len(s) - 1)
      end while
      m.server = s
    end if
  end if
  closeDialog()
  paint()
end sub

sub signIn()
  if m.user = "" or m.pass = ""
    m.message.text = "Type your username and your password first."
    return
  end if
  m.busy = true
  m.message.text = "Signing in..."
  m.global.server = m.server
  m.global.token = ""
  CallApi({ path: "/Users/AuthenticateByName", method: "POST", body: { Username: m.user, Pw: m.pass }, tag: "login" }, "onLogin")
end sub

sub onLogin(event as Object)
  m.busy = false
  r = event.getData()
  if r.ok and r.json <> invalid and r.json.AccessToken <> invalid
    m.global.token = r.json.AccessToken
    m.global.userId = r.json.User.Id
    m.global.userName = r.json.User.Name
    RegSet("server", m.server)
    RegSet("token", r.json.AccessToken)
    RegSet("userId", r.json.User.Id)
    RegSet("userName", r.json.User.Name)
    RegSet("lastUser", m.user)
    m.pass = ""
    m.message.text = ""
    m.top.signedIn = true
  else if r.status = 401 or r.status = 400
    m.message.text = "That username or password is not right."
  else if r.status = 0
    m.message.text = "Could not reach the server. Check your internet connection and the server address."
  else if r.status = 403
    m.message.text = "This account can't sign in right now. Ask who gave you the account."
  else
    m.message.text = "Could not sign in (" + r.status.ToStr() + "). Try again in a moment."
  end if
end sub
