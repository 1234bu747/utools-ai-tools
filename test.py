import requests
import json
import re

save_model = "gpt-5-chat-latest"
chat_id = 23038684695749
token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJNZW1iZXJJZCI6MTcwMjA2NDQ2OTM1NzMsIkFjY291bnRUeXBlIjoxLCJOaWNrTmFtZSI6Ik1fMkVKSEJ6THhUUUpuIiwiQWNjb3VudCI6ImJhaXhpOTUyN0BvdXRsb29rLmNvbSIsIkxvZ2luTW9kZSI6MSwiaWF0IjoxNzYxNzE5Njk1LCJuYmYiOjE3NjE3MTk2OTUsImV4cCI6MTc2MjkyOTI5NSwiaXNzIjoiQUlUb29scyIsImF1ZCI6IkFJVG9vbHMifQ.HHGqR10uAwpFLc-7uMyDUIGTpS5bjKE1rDF5DSSyqLo"

headers = {
    "Accept-Language": "zh-CN",
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json"
}

# 使用字典构建params
params_dict = {
    "chatPluginIds": [],
    "frequency_penalty": None,
    "max_tokens": 4096,
    "model": save_model,
    "presence_penalty": None,
    "requestMsgCount": 0,
    "speechVoice": "Alloy",
    "temperature": 0.8
}

payload = {
    "id": chat_id,
    "isLock": True,
    "params": json.dumps(params_dict),
    "roleId": 0,
    "roleInfo": None,
    "systemMessage": "",
    "title": "我是 ChatGPT"
}


# response = requests.post("https://ai.ufun.net/chatapi/chat/save", headers=headers, json=payload, verify=False)
# print(response.status_code)
# print(response.text)


def check_wallet_status(authorization):
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN",
        "Authorization": f"Bearer {authorization}",
    }

    try:
        print(requests.get("https://ai.ufun.net/chatapi/member/wallet", headers=headers, timeout=10).text)
    except Exception as e:
        print(f"获取钱包状态异常, {e}")


def strip_inline_code(s: str) -> str:
    # 去掉反引号包裹的内容
    return re.sub(r'`[^`]*`', '', s)


def check_table(line: str, last_line: str) -> bool:
    s = strip_inline_code(line.strip())
    if re.match(r'^\|.*\|$', s):
        table = True
    elif '|' not in line:
        table = False
    elif '|' in str(last_line):
        table = True
    else:
        table = False
    return table




def base(question: str):
    chat_id = 2222222
    authorization = "XXX"
    base_url = "https://ai.ufun.net/chatapi/chat/message"
    try:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN",
            "Authorization": f"Bearer {authorization}",
            "Content-Type": "application/json",
            "xx-cf-source": "GZ9+a3wcCRPtOCUJPlhmCQ=="
        }
        # msg = [{"content": "1+1", "role": "user", "contentFiles": []}, {"content": "1 + 1 equals 2.", "role": "assistant"}]
        payload = {
            "topicId": chat_id,
            "messages": msg,
            # 非追问时messages为空列表, 追问时入参如下, user是被追问问题用户输入字符，assistant是被追问问题AI回复内容
            # messages:
            # [{content: "1+1", role: "user", contentFiles: []}, {content: "1 + 1 equals 2.", role: "assistant"}]
            "content": question,
            "contentFiles": []
        }

        # 获取对话ID
        response = requests.post(base_url, headers=headers, json=payload, verify=False, timeout=30)
        print(response.text)
        if response.status_code != 200:
            print(response.text)
            yield response.text
            return

        # 成功示例: {"code":200,"extras":null,"message":"","result":[18761311234501,18761311236421],"type":"success"}
        json_data = response.json()
        message = json_data.get('message', '')
        if message:
            print(str(json_data))
            yield str(message)
            return

        # 获取已经进入对话轮询池的id
        try:
            get_id = json_data.get('result')[-1]
        except Exception as e:
            yield f'获取对话ID异常: {str(e)}'
            return

        # 获取轮询池的id中对话的结果
        send_headers = {
            "Accept-Language": "zh-CN",
            "Authorization": f"Bearer {authorization}",
            "Content-Type": "application/json"
        }
        send_url = f'{base_url}/{get_id}'
        response = requests.post(send_url, headers=send_headers, verify=False, stream=True, timeout=180)
        if response.status_code != 200:
            print(response.text)
            yield str(response.text)
            return

        try:
            total_result = ''
            is_code = False
            cite = False
            table = False
            last_line = None
            error = '正在调用搜索引擎🔎'
            error_num = 0
            for chunk in response.iter_lines():
                if chunk:
                    line = chunk.decode('utf-8')
                    line = str(line)
                    total_result += f"{line}\n"
                    if line.strip().startswith('```'):
                        is_code = not is_code
                    if error in line: error_num += 1
                    if error in line and error_num > 1: continue

                    try:
                        if not is_code:
                            lo = False
                            if line.strip().endswith(r'\n\n'):
                                line = line.strip()[:-4]

                            # 空行
                            if not line.strip(): continue
                            if not line.strip().startswith('>') and cite: yield '  \n'
                            if line.strip().startswith('>'):
                                cite = True
                            else:
                                cite = False

                            # 分隔符前加换行
                            if re.match(r'^[-=*_]+$', line.strip()): yield '  \n'
                            # 列表项多一个换行符
                            if re.match(r'^\s*(?:[+\-*]\s+|\d+\.\s+)', line): lo = True
                            # 表格结尾后的下一行前加换行
                            is_table = check_table(line, str(last_line))
                            if table and not is_table: yield '  \n\n'
                            table = is_table
                            last_line = line
                            if lo:
                                yield line + '   \n\n'
                            else:
                                yield line + '   \n'
                            if '视频生成成功，[点击这里](https:' in line:
                                # 正则匹配出http
                                pattern3 = r'https://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^)\s]*'
                                video_url = re.findall(pattern3, line)
                                if video_url:
                                    yield '  \n\n'
                                    yield f'<video width="320" height="240" controls><source src="{video_url[0]}" type="video/mp4">您的浏览器不支持视频播放。</video>  \n\n'

                        else:
                            yield line + '   \n'
                    except GeneratorExit:
                        # 当客户端断开连接时会触发 GeneratorExit
                        print("回答过程用户自己断开连接")
                        response.close()  # 关闭响应流
                        return
        except (BrokenPipeError, ConnectionError, requests.exceptions.ChunkedEncodingError, Exception) as e:
            print(f"回答过程连接断开或数据传输错误 - {str(e)}")
            response.close()  # 关闭响应流
            yield "[连接中断，请重试]"
            return

        if not total_result.strip():
            yield 'AI服务异常繁忙,请稍后重试！😢'
            return

        # 钱包
        check_wallet_status(authorization)
        return
    except Exception as e:
        print("运行过程报错")
        return

base("1+1")
