' One web request, made off the UI thread. The answer arrives in "response": {ok, status, json}.
sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    req = m.top.request
    result = { ok: false, status: 0, json: invalid }
    http = CreateObject("roUrlTransfer")
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.EnableEncodings(true)
    http.RetainBodyOnError(true)
    http.SetUrl(req.url)
    for each name in req.headers
        http.AddHeader(name, req.headers[name])
    end for
    port = CreateObject("roMessagePort")
    http.SetMessagePort(port)
    started = false
    if req.method = "GET"
        started = http.AsyncGetToString()
    else
        if req.method <> "POST" then http.SetRequest(req.method)
        started = http.AsyncPostFromString(req.body)
    end if
    if started
        msg = wait(20000, port)
        if type(msg) = "roUrlEvent"
            result.status = msg.GetResponseCode()
            result.ok = (result.status >= 200 and result.status < 300)
            body = msg.GetString()
            if body <> invalid and Len(body) > 0 then result.json = ParseJson(body)
        else
            http.AsyncCancel()
        end if
    end if
    m.top.response = result
end sub
