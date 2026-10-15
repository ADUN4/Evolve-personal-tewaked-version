import { global } from './vars';
import { messageQueue } from './functions.js';

// ---------------------------------------------------------------------------
// 云存档用的 PlayFab Title ID。
//
// 上游默认写死的是 'CE351'（pmotschmann 的公开 title）。本站已换成自己的 title；
// 继续用别人的意味着玩家的账号和存档都存在别人名下，而且不同分叉之间存档互通。
//
// Title ID 的单一来源是 lib/playfab-title.js —— index.html 的登录门和这里读同一个值，
// 只需要改那一处。配置步骤见仓库根目录的 CLOUD-SAVE.md。
// ---------------------------------------------------------------------------
PlayFab.settings.titleId = (typeof window !== 'undefined' && window.PLAYFAB_TITLE_ID) ? window.PLAYFAB_TITLE_ID : '';

if (!PlayFab.settings.titleId) {
    console.warn('[Evolve] 没拿到 PlayFab titleId，云存档不可用。检查 lib/playfab-title.js 是否加载成功（或翻 CLOUD-SAVE.md）');
}

export var playFabId = -1;

export var playFabStats = {
    isLogin : false,
    loginName: '',
    loginStat : '未登录',
    lastSaveTime: '',
    playFabSaveTime: ''
};


window.autoSaveToPlayFab = function () {
    var saveString = LZString.compressToBase64(JSON.stringify(global));
    saveToPlayFab(saveString);
}
setInterval(autoSaveToPlayFab, 30 * 60 * 1000);

// 登录：邮箱 + 密码
// 无参数调用时会从表单里取（#playfab-email / #playfab-password），
// 带参数调用用于自动登录（见 tryPlayFabAutoLogin）。
window.loginPlayFab = function (email, pass) {
    var error = $("#playfab-error");
    if (!email || !pass) {
        var mailElem = $("#playfab-email");
        var passElem = $("#playfab-password");

        if (mailElem == null || passElem == null) {
            error.html("error");
            return;
        }
        else {
            email = $.trim(mailElem.val());
            pass = passElem.val();
        }
    }
    if (!email || !pass) {
        error.html("请填写邮箱和密码");
        return;
    }
    var requestData = {
        Email: email,
        Password: pass
    }
    try {
        storeTempPlayFabInfo(email, pass);
        PlayFab.ClientApi.LoginWithEmailAddress(requestData, playFabLoginCallback).catch(function (error) {
            var err = Object.values(error.errorDetails).join('<br>');
            $('#playfab-error').html(err);
        });
    }
    catch (e) {
        console.log(e);
        error.html("连接不上PlayFab服务");
    }
}

// 注册：邮箱 + 密码
// PlayFab 会往该邮箱发验证邮件；未验证的邮箱通常也能登录，但找回密码依赖它。
window.registerPlayFabUser = function () {
    var error = $("#playfab-reg-error");

    var mailElem = $("#playfab-reg-email");
    var passElem = $("#playfab-reg-password");
    var confirmPasswordElem = $("#playfab-reg-confirm-password");
    if (mailElem == null || passElem == null || confirmPasswordElem == null) {
        //Elements required to register are missing, rebuild login screen
        error.html('请填写完整');
        return;
    }
    if (confirmPasswordElem.val() != passElem.val()) {
        error.html("两次密码不一致");
        return;
    }
    var email = $.trim(mailElem.val());
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        error.html("请填写正确的邮箱地址");
        return;
    }
    // PlayFab 的密码规则是 6-100 个字符
    var pass = passElem.val();
    if (pass.length < 6 || pass.length > 100) {
        error.html("密码长度需要 6-100 位");
        return;
    }
    var requestData = {
        Email: email,
        Password: pass,
        RequireBothUsernameAndEmail: false
    }
    storeTempPlayFabInfo(email, pass);
    PlayFab.ClientApi.RegisterPlayFabUser(requestData, playFabLoginCallback).catch(function (error) {
        var err = Object.values(error.errorDetails).join('<br>');
        $('#playfab-reg-error').html(err);
    });
}

// 找回密码：让 PlayFab 往注册邮箱发重置邮件
window.recoverPlayFabAccount = function () {
    var error = $("#playfab-error");
    var mailElem = $("#playfab-email");
    if (mailElem == null) {
        return;
    }
    var email = $.trim(mailElem.val());
    if (!email) {
        error.html("请先在上面填写注册时用的邮箱");
        return;
    }
    try {
        PlayFab.ClientApi.SendAccountRecoveryEmail({ Email: email }, function (data, err) {
            if (err) {
                error.html("发送失败，请确认这个邮箱是否已经注册过");
                return;
            }
            error.html("重置密码的邮件已发出，请查收（也看看垃圾箱）");
        });
    }
    catch (e) {
        console.log(e);
        error.html("连接不上PlayFab服务");
    }
}


// index.html 的登录门（强制登录）成功后写入这个标记
export const LOGIN_REQUIRED_KEY = 'evolveLoginRequired';

export function isLoginRequired() {
    try {
        return localStorage.getItem(LOGIN_REQUIRED_KEY) === '1';
    } catch (e) {
        return false;
    }
}

export function tryPlayFabAutoLogin() {
    // 站点开了强制登录，就无条件打开云存档开关。
    // 老存档里的 settings.onlineSave 可能是 false，不强制打开的话
    // saveToPlayFab 会直接 return，登录了也不会往云上存。
    if (isLoginRequired()) {
        global.settings.onlineSave = true;
    }
    var type = global.settings.onlineSave;
    //-1 = not set, 1 = Kongregate, 2 = PlayFab
    if (type == false) {
        return false;
    }
    var info = readPlayFabInfo();
    if (!info) return false;
    loginPlayFab(info[0], info[1]);
    return true;
}

function playFabLoginCallback(data, error) {
    if (error) {
        var errorElem = $("#playfab-error");
        if (errorElem != null && error.errorMessage) {
            errorElem.html(error.errorMessage);
        }
        return;
    }
    if (data) {
        playFabStats.isLogin = true;
        var tempuser = readTempPlayFabInfo();
        storePlayFabInfo(tempuser[0], tempuser[1]);
        playFabStats.loginName = tempuser[0];
        playFabStats.loginStat = '已登录(' + maskEmail(playFabStats.loginName) + ')';
        playFabId = data.data.PlayFabId;
        $('.login-content input').val('');
        playFabSaveCheck();
    }
}

// 界面上不直接显示完整邮箱
function maskEmail(email) {
    if (typeof email !== 'string' || email.indexOf('@') === -1) return email;
    var parts = email.split('@');
    var name = parts[0];
    var visible = name.length <= 2 ? name.charAt(0) : name.substring(0, 2);
    return visible + '***@' + parts[1];
}

function cancelPlayFab() {
    playFabId = -1;
}

function playFabSaveCheck() {
    if (playFabId == -1) return false;
    var requestData = {
        Keys: ["gameTotalDays"],
        PlayFabId: playFabId
    }
    try {
        PlayFab.ClientApi.GetUserData(requestData, playFabSaveCheckCallback);
    }
    catch (e) { console.log(e); }
}

function playFabSaveCheckCallback(data, error) {
    if (error) {
        console.log("error checking existing PlayFab data");
        console.log(error);
        return;
    }
    if (data) {
        var gameTotalDays = (data.data.Data.gameTotalDays) ? parseInt(data.data.Data.gameTotalDays.Value) : 0;
        var saveString = data.data.Data.saveString ? data.data.Data.saveString : null;
        if (saveString != null) {
            playFabStats.playFabSaveTime = moment(saveString.LastUpdated).format("YYYY-MM-DD HH:mm:ss");
        }
        playFabFinishLogin(true);
    }
}

function playFabFinishLogin(downloadFirst) {
    if (downloadFirst) {
        //交由用户手动load
        loadFromPlayFab();
        return;
    }
}

function saveToPlayFab(saveString) {
    if (global.beta) return;
    // 站点开了强制登录，云存档就是必须的：即使玩家在设置里把开关关掉，
    // 也照样上传，否则「登录了但进度没上云」会变成最坑人的那种 bug。
    if (isLoginRequired()) { global.settings.onlineSave = true; }
    if (!global.settings.onlineSave) return;
    if (!playFabId || typeof PlayFab === 'undefined' || typeof PlayFab.ClientApi === 'undefined') return false;
    var requestData = {
        Data: {
            saveString: saveString,
            gameTotalDays: global.stats.days + global.stats.tdays,
        }
    }
    try {
        PlayFab.ClientApi.UpdateUserData(requestData, saveToPlayFabCallback);
    }
    catch (e) { console.log(e); }
}

var playFabSaveErrors = 0;

function saveToPlayFabCallback(data, error) {
    if (error) {
        playFabSaveErrors++;
        messageQueue("连不上云存档了，检查一下你的网络链接，最好备份一下存档噢");
        console.log(error);
        if (playFabId != -1) {
            playFabAttemptReconnect();
        }
        return false;
    }
    if (data) {
        messageQueue("成功备份到云存档，下一次备份将在30分钟后",'info');
        playFabStats.lastSaveTime = moment().format("YYYY-MM-DD HH:mm:ss");
        playFabStats.playFabSaveTime = moment().format("YYYY-MM-DD HH:mm:ss");
        return true;
    }
}

function playFabAttemptReconnect(reconnected) {
    console.log((reconnected) ? "Reconnected" : "Attempting to reconnect");
    if (reconnected) {
        playFabSaveErrors = 0;
        return;
    }
    tryPlayFabAutoLogin();
}

window.importFromPlayFab = function () {
    importFromPlayFab();
}
window.syncNow = function () {
    autoSaveToPlayFab();
}

// 登出：先把当前进度推一次云端，再清掉本地凭据并回到登录门。
// evolveLoginRequired 是站点级标记，**不清** —— 清了游戏就不再强制打开云存档开关了。
window.logoutPlayFab = function () {
    try {
        if (playFabId && global.settings.onlineSave) {
            saveToPlayFab(LZString.compressToBase64(JSON.stringify(global)));
        }
    } catch (e) { console.log(e); }
    playFabId = -1;
    playFabStats.isLogin = false;
    playFabStats.loginStat = '未登录';
    playFabStats.loginName = '';
    try {
        localStorage.removeItem('playFabName');
        localStorage.removeItem('playFabPass');
        localStorage.removeItem('playFabNameTemp');
        localStorage.removeItem('playFabPassTemp');
    } catch (e) { console.log(e); }
    messageQueue('已登出，正在返回登录页…', 'info');
    // 留一点时间让最后那次备份发出去
    setTimeout(function () { location.reload(); }, 1500);
};

function importFromPlayFab() {
    if (!playFabId || typeof PlayFab === 'undefined' || typeof PlayFab.ClientApi === 'undefined') return false;
    var requestData = {
        Keys: ["saveString"],
        PlayFabId: playFabId
    }
    try {
        PlayFab.ClientApi.GetUserData(requestData, function (data,error) {
            if (error) {
                console.log(error);
                return;
            }
            if (data) {
                var saveString = data.data.Data.saveString ? data.data.Data.saveString : null;
                if (saveString != null) {
                    playFabStats.playFabSaveTime = moment(saveString.LastUpdated).format("YYYY-MM-DD HH:mm:ss");
                    if (!importGame(saveString.Value)) {
                        playFabId = -1;
                        $('#playfab-error').html('加载存档错误');
                        return;
                    }
                }
            }
        });
    }
    catch (e) { console.log(e); }

}

function loadFromPlayFab() {
    if (!playFabId || typeof PlayFab === 'undefined' || typeof PlayFab.ClientApi === 'undefined') return false;
    var requestData = {
        Keys: ["saveString"],
        PlayFabId: playFabId
    }
    try {
        PlayFab.ClientApi.GetUserData(requestData, loadFromPlayFabCallback);
    }
    catch (e) { console.log(e); }
}

function loadFromPlayFabCallback(data, error) {
    if (error) {
        console.log(error);
        return;
    }
    if (data) {
        var saveString = data.data.Data.saveString ? data.data.Data.saveString : null;
        if (saveString != null) {
            playFabStats.playFabSaveTime = moment(saveString.LastUpdated).format("YYYY-MM-DD HH:mm:ss");
        }
    }
}

// 注意：这里把邮箱和密码明文存在 localStorage 里（继承自上游实现），
// 只对同源脚本可见，且本站已移除第三方脚本，风险可控但不是最佳实践。
// 想更稳妥可以改成存 PlayFab 返回的 SessionTicket（换设备时失效，需要重新登录）。
function storePlayFabInfo(name, pass) {
    try {
        localStorage.setItem("playFabName", name);
        localStorage.setItem("playFabPass", pass);
    }
    catch (e) { console.log(e) }
    return false;
}
function storeTempPlayFabInfo(name, pass) {
    try {
        localStorage.setItem("playFabNameTemp", name);
        localStorage.setItem("playFabPassTemp", pass);
    }
    catch (e) { console.log(e) }
    return false;
}

function readPlayFabInfo() {
    var info = [false, false];
    try {
        info[0] = localStorage.getItem("playFabName");
        info[1] = localStorage.getItem("playFabPass");
    }
    catch (e) { console.log(e) }
    if (info[0] && info[1]) return info;
    return false;
}
function readTempPlayFabInfo() {
    var info = [false, false];
    try {
        info[0] = localStorage.getItem("playFabNameTemp");
        info[1] = localStorage.getItem("playFabPassTemp");
    }
    catch (e) { console.log(e) }
    if (info[0] && info[1]) return info;
    return false;
}
