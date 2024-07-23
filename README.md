在[原项目](https://github.com/zizifn/edgetunnel)的基础上美化了配置信息的显示样式，并加入了一键复制按钮。 

## 改动
* 新增了使用Url参数动态修改uuid和proxyip的方式  

* 由于新增了动态修改uuid和proxyip的功能，所以不再支持/uuid的方式展示配置信息  
修改为在代码第15行设置`password`变量为展示配置信息的入口，默认值为zeb  
  
* 强制要求更改uuid，不再允许使用默认的uuid



## 好处  
* uuid和proxy以参数方式动态调用，当proxyip失效的时候（会导致cf类网站无法访问。例v2ex）免去登陆cf编辑workers代码或在cf workers后台设置环境变量

* 可以和订阅workers进行联动，可以获取N个节点并通过动态修改proxyip和优选ip，实现固定某个国家或者地区

* 懒人配置无需优选ip，复制即可使用。tls的需要客户端开启分片功能，目前[【v2rayN Windows端】](https://github.com/2dust/v2rayN/releases/latest)和[【v2rayN Android端】](https://github.com/2dust/v2rayNG/releases/latest)都支持分片功能。

## 使用方法  


* [【UUID在线生成网站1】](https://www.uuidgenerator.net/)  、  [【UUID在线生成网站2】](https://1024tools.com/uuid)  、  或在v2rayN客户端，添加vless节点页面中，有一键生成UUID的功能

* 复制  `zeb_workers.js`  的内容，粘贴到新的workers中，并修改第15行的`password`变量值，保存并部署  

* 进入展示配置信息页面的链接为：/{password变量值}?uuid={xxxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
  
  例：`https://xxx.xxxx.workers.dev/zeb?uuid=806f86be-9fa2-4195-adca-445f5b52243e`



## 展示配置信息页面截图
![image](https://raw.githubusercontent.com/Cfwnodeyes/cfyyds/main/1.png)
