' Aurora for Roku: a native app for the same server as the Aurora Android and web apps.
sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    info = CreateObject("roDeviceInfo")
    globalNode = screen.GetGlobalNode()
    globalNode.addFields({
        server: "https://emby4836.duckdns.org:8920"
        deviceId: info.GetChannelClientId()
        deviceName: info.GetModelDisplayName()
        token: ""
        userId: ""
    })
    screen.CreateScene("MainScene")
    screen.Show()
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
    end while
end sub
