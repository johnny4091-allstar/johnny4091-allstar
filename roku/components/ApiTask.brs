' One web request, made off the main thread. Reads the server and the sign-in from the global node.
sub init()
  m.top.functionName = "execute"
end sub

sub execute()
  req = m.top.request
  g = m.global
  method = "GET"
  if req.method <> invalid then method = UCase(req.method)
  if req.base = "guard"
    url = g.guard + req.path
  else
    url = g.server + "/emby" + req.path
  end if

  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.EnableEncodings(true)

  query = ""
  if req.query <> invalid
    for each key in req.query
      if query = "" then query = "?" else query = query + "&"
      query = query + key + "=" + xfer.Escape(req.query[key].ToStr())
    end for
  end if
  if req.base = "guard"
    ' The Guard knows who is asking from the sign-in token and this user id.
    if query = "" then query = "?" else query = query + "&"
    query = query + "userId=" + xfer.Escape(g.userId)
  end if

  q = Chr(34)
  auth = "MediaBrowser Client=" + q + "Aurora" + q + ", Device=" + q + "Roku" + q + ", DeviceId=" + q + g.deviceId + q + ", Version=" + q + g.appVersion + q
  if g.token <> "" then auth = auth + ", Token=" + q + g.token + q
  xfer.AddHeader("X-Emby-Authorization", auth)
  if g.token <> "" then xfer.AddHeader("X-Emby-Token", g.token)
  xfer.AddHeader("Accept", "application/json")
  xfer.SetUrl(url + query)

  port = CreateObject("roMessagePort")
  xfer.SetPort(port)
  started = false
  if method = "GET"
    started = xfer.AsyncGetToString()
  else
    xfer.AddHeader("Content-Type", "application/json")
    xfer.SetRequest(method)
    body = ""
    if req.body <> invalid then body = FormatJson(req.body)
    started = xfer.AsyncPostFromString(body)
  end if

  result = { ok: false, status: 0, json: invalid, text: "", tag: req.tag }
  if started
    timeout = 30000
    if req.timeout <> invalid then timeout = req.timeout
    msg = wait(timeout, port)
    if type(msg) = "roUrlEvent"
      result.status = msg.GetResponseCode()
      text = msg.GetString()
      if text <> invalid then result.text = text
      result.ok = (result.status >= 200 and result.status < 300)
      if result.text <> "" then result.json = ParseJson(result.text)
    else
      xfer.AsyncCancel()
    end if
  end if
  m.top.response = result
end sub
