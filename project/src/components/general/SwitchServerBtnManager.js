import { setting } from "./Setting.js"

const SOURCE_ICON = `
    <svg class="server-trigger-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="5" width="16" height="11" rx="2.5"></rect>
        <path d="m7.5 13 3.2-3.2 2.4 2.2 1.7-1.7 2.2 2.2"></path>
        <circle cx="15.8" cy="8.3" r="1"></circle>
        <path d="M8 20h8M12 16v4"></path>
    </svg>`

export class SwitchServerBtnManager{
    switchServerDom
    titleDom
    serverBtnDoms
    activeIndex=0
    constructor(){
        this.switchServerDom=document.querySelector(".switch-server")
        this.titleDom=this.switchServerDom.querySelector("span")
        this.menuDom=this.switchServerDom.querySelector(".sh-sr-cr")
        this.serverBtnDoms=this.switchServerDom.querySelectorAll(".server-name")
    }
    init(){
        this.titleDom.innerHTML=SOURCE_ICON
        this.switchServerDom.classList.add("is-ready")
        if(!this.menuDom.id)this.menuDom.id="image-source-menu"
        this.menuDom.setAttribute("role","listbox")
        this.menuDom.setAttribute("aria-label","图片线路")
        this.menuDom.setAttribute("aria-hidden","true")
        this.serverBtnDoms.forEach((option,index)=>{
            option.id=`image-source-option-${index+1}`
            option.setAttribute("role","option")
            option.setAttribute("tabindex","-1")
        })
        this.titleDom.setAttribute("role","button")
        this.titleDom.setAttribute("tabindex","0")
        this.titleDom.setAttribute("aria-haspopup","listbox")
        this.titleDom.setAttribute("aria-controls",this.menuDom.id)
        this.titleDom.setAttribute("aria-expanded","false")
        this.setServer(+setting.using_imgserver_index)
        this.#addEvent()
    }
    #addEvent(){
        const setOpen=(open,focusOption=false)=>{
            if(!open&&this.menuDom.contains(document.activeElement)){
                this.titleDom.focus({preventScroll:true})
            }
            this.switchServerDom.classList.toggle("open",open)
            this.titleDom.setAttribute("aria-expanded",String(open))
            this.menuDom.setAttribute("aria-hidden",String(!open))
            if(open&&focusOption){
                this.serverBtnDoms.forEach((option,index)=>option.setAttribute("tabindex",index===this.activeIndex?"0":"-1"))
                this.serverBtnDoms[this.activeIndex]?.focus({preventScroll:true})
            }
        }
        const toggle=()=>setOpen(!this.switchServerDom.classList.contains("open"))
        this.titleDom.addEventListener("click",toggle)
        this.titleDom.addEventListener("keydown",(event)=>{
            if(event.key==="Enter"||event.key===" "){
                event.preventDefault()
                event.stopPropagation()
                const willOpen=!this.switchServerDom.classList.contains("open")
                setOpen(willOpen,willOpen)
            }else if(event.key==="ArrowDown"||event.key==="ArrowUp"){
                event.preventDefault()
                event.stopPropagation()
                setOpen(true,true)
            }
        })
        for(let i=0;i<this.serverBtnDoms.length;i++){
            this.serverBtnDoms[i].addEventListener("click",()=>{
                this.setServer(i)
                setting.setOption("using_imgserver_index",i)
                setOpen(false)
                this.titleDom.focus({preventScroll:true})
            })
        }
        document.addEventListener("click",(event)=>{
            if(!this.switchServerDom.contains(event.target))setOpen(false)
        })
        this.switchServerDom.addEventListener("keydown",(event)=>{
            const current=Array.from(this.serverBtnDoms).indexOf(event.target.closest?.(".server-name"))
            if(event.key==="Escape"){
                event.preventDefault()
                setOpen(false)
                this.titleDom.focus({preventScroll:true})
                return
            }
            if(current<0)return
            let next=null
            if(event.key==="ArrowDown")next=(current+1)%this.serverBtnDoms.length
            else if(event.key==="ArrowUp")next=(current-1+this.serverBtnDoms.length)%this.serverBtnDoms.length
            else if(event.key==="Home")next=0
            else if(event.key==="End")next=this.serverBtnDoms.length-1
            else if(event.key==="Enter"||event.key===" "){
                event.preventDefault()
                this.serverBtnDoms[current].click()
                return
            }
            if(next!==null){
                event.preventDefault()
                this.serverBtnDoms[current].setAttribute("tabindex","-1")
                this.serverBtnDoms[next].setAttribute("tabindex","0")
                this.serverBtnDoms[next].focus({preventScroll:true})
            }
        })
    }
    setServer(index){
        index = Number.isInteger(index) && index >= 0 && index < this.serverBtnDoms.length ? index : 0
        this.serverBtnDoms[this.activeIndex].classList.remove("active")
        
        this.serverBtnDoms.forEach((option,optionIndex)=>{
            const active=optionIndex===index
            option.classList.toggle("active",active)
            option.setAttribute("aria-selected",String(active))
            option.setAttribute("tabindex",active?"0":"-1")
        })
        const current=index+1
        this.titleDom.setAttribute("aria-label",`选择图片线路，当前图源 ${current}`)
        this.titleDom.title=`当前图源 ${current}`
        this.activeIndex=index

    }
}
