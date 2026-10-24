import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {TaskWorkspace} from "./task.js";
const reply=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function fixture(variant="OWNER", items: unknown[] = [], calendarAvailable = true) {
 window.history.replaceState(null,"","/my-work?scope=personal&phase=active");
 const requests:URL[]=[];
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input),"http://localhost");requests.push(url);
  if(url.pathname.endsWith("/setup"))return reply({actorEmployeeId:variant==="OWNER"?null:"leader",creationProfile:{version:1,variant,resolution:"CONFIGURED_ROLE"},canAssign:variant!=="EMPLOYEE",projects:[],planItems:[],employees:[{id:"person-a",name:"Ada",homeBranchId:"branch",homeTeamId:"team-a",homeTeamName:"Design"},{id:"person-b",name:"Ben",homeBranchId:"branch",homeTeamId:"team-b",homeTeamName:"Site"}]});
  if(url.pathname === "/api/v1/tasks") return reply({ total: items.length, items });
  if(url.pathname.includes("/dashboard/sources/tasks"))return calendarAvailable ? reply({source:"tasks",today:"2026-10-23",sections:[]}) : new Response("", {status:503});
  return reply({total:0,items:[]});
 }));return requests;
}
it.each(["OWNER","LEADER"])("switches %s from personal tasks to authorized team/employee drill-down",async variant=>{
 const requests=fixture(variant);render(<TaskWorkspace csrfToken="csrf" owner={variant==="OWNER"} listFirst personalOnly />);
 fireEvent.click(await screen.findByRole("button",{name:"All teams"}));
 await waitFor(()=>expect(requests.some(u=>u.pathname==="/api/v1/tasks"&&u.searchParams.get("scope")==="all")).toBe(true));
 expect(screen.queryByRole("region",{name:"Work overview"})).not.toBeInTheDocument();
 expect(screen.getByText("No authorized tasks match this team, employee and filters.")).toBeInTheDocument();
 fireEvent.click(screen.getByText("Display and refresh"));
 expect(screen.getByRole("button",{name:"Refresh"})).toBeInTheDocument();
 fireEvent.change(screen.getByRole("combobox",{name:"Work team"}),{target:{value:"team-a"}});
 expect(screen.getByRole("combobox",{name:"Work employee"})).toHaveTextContent("Ada");expect(screen.getByRole("combobox",{name:"Work employee"})).not.toHaveTextContent("Ben");
 fireEvent.change(screen.getByRole("combobox",{name:"Work employee"}),{target:{value:"person-a"}});
 await waitFor(()=>expect(requests.some(u=>u.searchParams.get("scope")==="all"&&u.searchParams.get("teamId")==="team-a"&&u.searchParams.get("ownerEmployeeId")==="person-a")).toBe(true));
 fireEvent.change(screen.getByRole("combobox",{name:"Work team"}),{target:{value:"team-b"}});expect(screen.getByRole("combobox",{name:"Work employee"})).toHaveValue("");
 fireEvent.click(screen.getByRole("button",{name:"My Work"}));
 await waitFor(()=>expect(new URL(window.location.href).searchParams.get("scope")).toBe("personal"));expect(screen.queryByRole("combobox",{name:"Work team"})).not.toBeInTheDocument();
});
it.each([true,false])("never derives management Today from a task Target when calendar available=%s",async available=>{
 fixture("OWNER",[{id:"future",title:"Future work",type:"NON_PROJECT",priority:"HIGH",targetDate:"2026-11-06T00:00:00Z",primaryOwnerEmployeeId:"person-a",status:"NOT_STARTED",version:1,reviewRequirement:"NONE",createdAt:"2026-10-23T00:00:00Z"}],available);
 window.history.replaceState(null,"","/my-work?scope=all&phase=active");render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
 expect(await screen.findByText("Future work")).toBeInTheDocument();
 if(available) await waitFor(()=>expect(document.querySelector(".my-work-group-head")).toHaveTextContent("Next week"));
 else expect(await screen.findByText(/Organization calendar unavailable or loading/)).toBeInTheDocument();
 expect(document.querySelector(".my-work-group-head")).not.toHaveTextContent("Today");
});
it("keeps ordinary employees in personal work",async()=>{
 const requests=fixture("EMPLOYEE");render(<TaskWorkspace csrfToken="csrf" owner={false} listFirst personalOnly />);
 await waitFor(()=>expect(requests.some(u=>u.pathname.endsWith("/setup"))).toBe(true));
 expect(screen.queryByRole("button",{name:"All teams"})).not.toBeInTheDocument();
});
it("restores a management bookmark without activating the personal attention queue",async()=>{
 const requests=fixture();window.history.replaceState(null,"","/my-work?scope=all&workPhase=attention&phase=completed");
 render(<TaskWorkspace csrfToken="csrf" owner listFirst personalOnly />);
 expect(await screen.findByRole("combobox",{name:"Management work phase"})).toHaveValue("completed");
 await waitFor(()=>expect(requests.some(u=>u.pathname==="/api/v1/tasks"&&u.searchParams.get("scope")==="all"&&u.searchParams.get("phase")==="completed")).toBe(true));
 expect(new URL(window.location.href).searchParams.has("workPhase")).toBe(false);
});
