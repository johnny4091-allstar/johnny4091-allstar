' Aurora for Roku. Starts the scene, puts the things every part of the app needs (server, sign-in, device) in the global node, and waits.
sub Main(args as Dynamic)
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)
  g = screen.getGlobalNode()
  info = CreateObject("roDeviceInfo")
  g.addFields({
    server: RegGet("server", AuroraServerDefault()),
    guard: AuroraGuardDefault(),
    token: RegGet("token", ""),
    userId: RegGet("userId", ""),
    userName: RegGet("userName", ""),
    deviceId: info.GetChannelClientId(),
    appVersion: "1.0.0"
  })
  scene = screen.CreateScene("MainScene")
  screen.Show()
  while true
    msg = wait(0, port)
    if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
  end while
end sub
