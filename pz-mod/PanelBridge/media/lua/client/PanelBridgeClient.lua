-- PanelBridge client companion for effects that the dedicated server cannot
-- reliably replicate through its own Lua API.

local function sendTeleportAck(requestId, status, x, y, z, errorMessage)
    if not sendClientCommand then return end
    pcall(function()
        sendClientCommand("PanelBridge", "teleportAck", {
            requestId = requestId,
            status = status,
            x = x,
            y = y,
            z = z,
            error = errorMessage
        })
    end)
end

local function handleTeleport(args)
    args = args or {}
    local requestId = tostring(args.requestId or "")
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    if not x or not y then
        sendTeleportAck(requestId, "failed", nil, nil, nil, "Invalid teleport coordinates")
        return
    end

    local player = nil
    if getSpecificPlayer then player = getSpecificPlayer(0) end
    if not player and getPlayer then player = getPlayer() end
    if not player then
        sendTeleportAck(requestId, "failed", nil, nil, nil, "Local player is not available")
        return
    end

    local ok, err = pcall(function()
        player:teleportTo(x, y, z)
    end)
    if not ok then
        local xOk = pcall(function() player:setX(x) end)
        local yOk = pcall(function() player:setY(y) end)
        local zOk = pcall(function() player:setZ(z) end)
        ok = xOk and yOk and zOk
        err = ok and nil or err
    end

    local function readNumber(methodName)
        local readOk, value = pcall(function()
            if methodName == "getX" then return player:getX() end
            if methodName == "getY" then return player:getY() end
            return player:getZ()
        end)
        return readOk and tonumber(value) or nil
    end
    local actualX = readNumber("getX")
    local actualY = readNumber("getY")
    local actualZ = readNumber("getZ")
    local moved = ok and actualX and actualY and actualZ
        and math.abs(actualX - x) <= 1.5
        and math.abs(actualY - y) <= 1.5
        and math.abs(actualZ - z) <= 1.5

    if moved then
        sendTeleportAck(requestId, "applied", actualX, actualY, actualZ)
    else
        sendTeleportAck(requestId, "failed", actualX, actualY, actualZ,
            tostring(err or "Local teleport did not reach the requested position"))
    end
end

local function onServerCommand(module, command, args)
    if module == "PanelBridge" and command == "teleport" then
        handleTeleport(args)
    end
end

if Events and Events.OnServerCommand and Events.OnServerCommand.Add then
    Events.OnServerCommand.Add(onServerCommand)
end
