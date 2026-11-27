sub init()
  m.buttons = m.top.findNode("buttons")
  m.top.findNode("who").text = "Signed in as " + m.global.userName
  m.top.findNode("server").text = "Server: " + m.global.server
  m.top.findNode("version").text = "Aurora for Roku " + m.global.appVersion
  m.buttons.buttons = ["Sign out"]
  m.buttons.observeField("buttonSelected", "onButton")
end sub

sub onButton(event as Object)
  m.top.signOutRequested = true
end sub

sub refresh()
  m.top.findNode("who").text = "Signed in as " + m.global.userName
end sub

sub focusContent()
  m.buttons.setFocus(true)
end sub
