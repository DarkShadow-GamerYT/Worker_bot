'use strict';

const mcDataLoader = require('minecraft-data');
const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const { GoalFollow, GoalNear } = goals;

function parseArgs(input) {
  const args = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;

  while ((match = regex.exec(input)) !== null) {
    args.push((match[1] || match[2] || match[3]).replace(/\\(["'])/g, '$1'));
  }

  return args;
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_');
}

function toCount(value, fallback = 1, max = 256) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function formatPosition(position) {
  return `${Math.floor(position.x)} ${Math.floor(position.y)} ${Math.floor(position.z)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCommandRunner(bot, options = {}) {
  const state = {
    activeTask: null,
    attackTimer: null,
    mcData: null,
    movements: null
  };

  function onSpawn() {
    state.mcData = mcDataLoader(bot.version);
    state.movements = new Movements(bot, state.mcData);
    state.movements.canDig = Boolean(options.pathfinderCanDig);
    bot.pathfinder.setMovements(state.movements);
  }

  function ensureReady() {
    if (!state.mcData) onSpawn();
  }

  function stopPathing() {
    if (bot.pathfinder) {
      bot.pathfinder.setGoal(null);
      if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
    }

    if (bot.collectBlock && typeof bot.collectBlock.cancelTask === 'function') {
      bot.collectBlock.cancelTask().catch(() => {});
    }

    bot.clearControlStates();
  }

  function clearActiveTask({ cancel = false } = {}) {
    if (!state.activeTask) return;

    const task = state.activeTask;
    state.activeTask = null;

    if (state.attackTimer) {
      clearInterval(state.attackTimer);
      state.attackTimer = null;
    }

    if (cancel && typeof task.cancel === 'function') {
      task.cancel();
    }
  }

  function setActiveTask(name, cancel) {
    clearActiveTask({ cancel: true });
    state.activeTask = { name, cancel };
  }

  async function runTask(name, reply, username, taskBody) {
    setActiveTask(name, stopPathing);

    try {
      await taskBody();
      if (state.activeTask && state.activeTask.name === name) {
        clearActiveTask();
        await reply(username, `Done: ${name}`);
      }
    } catch (error) {
      if (state.activeTask && state.activeTask.name === name) clearActiveTask({ cancel: true });
      throw error;
    }
  }

  function blockByName(name) {
    const normalized = normalizeName(name);
    return state.mcData.blocksByName[normalized];
  }

  function itemByName(name) {
    const normalized = normalizeName(name);
    return state.mcData.itemsByName[normalized];
  }

  function inventoryItem(name) {
    const normalized = normalizeName(name);
    return bot.inventory.items().find((item) => item.name === normalized);
  }

  function playerEntity(username, requestedName) {
    const name = requestedName || username;
    const exactPlayer = bot.players[name];
    if (exactPlayer) return exactPlayer.entity;

    const playerName = Object.keys(bot.players).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const player = playerName ? bot.players[playerName] : null;
    return player ? player.entity : null;
  }

  function nearestEntityByName(name) {
    const normalized = normalizeName(name);

    return bot.nearestEntity((entity) => {
      if (entity === bot.entity) return false;
      if (!entity.position) return false;
      if (entity.type !== 'mob' && entity.type !== 'player') return false;

      const entityName = normalizeName(entity.name || entity.displayName || entity.username || '');
      return normalized === 'nearest' || entityName === normalized;
    });
  }

  async function commandHelp(username, reply) {
    await reply(
      username,
      'Commands: help, status, come, follow [player], stop, goto x y z, mine block [count], place block x y z, equip item [slot], inventory, drop item [count], craft item [count], sleep, wake, attack mob, say text'
    );
  }

  async function commandStatus(username, reply) {
    const position = formatPosition(bot.entity.position);
    const task = state.activeTask ? state.activeTask.name : 'idle';
    const invCount = bot.inventory.items().length;
    await reply(username, `Health ${Math.round(bot.health)}/20, food ${bot.food}/20, pos ${position}, inv ${invCount}, task ${task}`);
  }

  async function commandCome(username, reply) {
    const target = playerEntity(username);
    if (!target) throw new Error("I can't see you.");

    const position = target.position;
    await reply(username, `Coming to ${formatPosition(position)}.`);
    await runTask(`come to ${username}`, reply, username, async () => {
      await bot.pathfinder.goto(new GoalNear(position.x, position.y, position.z, 1));
    });
  }

  async function commandFollow(username, args, reply) {
    const targetName = args[0] || username;
    const target = playerEntity(username, targetName);
    if (!target) throw new Error(`I can't see ${targetName}.`);

    setActiveTask(`follow ${targetName}`, stopPathing);
    bot.pathfinder.setMovements(state.movements);
    bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
    await reply(username, `Following ${targetName}.`);
  }

  async function commandStop(username, reply) {
    clearActiveTask({ cancel: true });
    stopPathing();
    await reply(username, 'Stopped.');
  }

  async function commandGoto(username, args, reply) {
    if (args.length < 3) throw new Error('Usage: goto x y z');

    const [x, y, z] = args.map(Number);
    if (![x, y, z].every(Number.isFinite)) throw new Error('Usage: goto x y z');

    await reply(username, `Going to ${x} ${y} ${z}.`);
    await runTask(`goto ${x} ${y} ${z}`, reply, username, async () => {
      await bot.pathfinder.goto(new GoalNear(x, y, z, 1));
    });
  }

  async function commandMine(username, args, reply) {
    if (args.length < 1) throw new Error('Usage: mine block_name [count]');

    const blockType = blockByName(args[0]);
    if (!blockType) throw new Error(`Unknown block: ${args[0]}`);

    const count = toCount(args[1], 1, 128);
    const positions = bot.findBlocks({
      matching: blockType.id,
      maxDistance: 64,
      count
    });
    const blocks = positions.map((position) => bot.blockAt(position)).filter(Boolean);

    if (blocks.length === 0) throw new Error(`No nearby ${blockType.name} found.`);

    await reply(username, `Mining ${blocks.length} ${blockType.name}.`);
    await runTask(`mine ${blocks.length} ${blockType.name}`, reply, username, async () => {
      await bot.collectBlock.collect(blocks.length === 1 ? blocks[0] : blocks);
    });
  }

  async function commandPlace(username, args, reply) {
    if (args.length < 4) throw new Error('Usage: place block_name x y z');

    const item = inventoryItem(args[0]);
    if (!item) throw new Error(`I do not have ${args[0]}.`);

    const [x, y, z] = args.slice(1, 4).map(Number);
    if (![x, y, z].every(Number.isFinite)) throw new Error('Usage: place block_name x y z');

    const targetPosition = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const existing = bot.blockAt(targetPosition);
    if (existing && existing.boundingBox !== 'empty') {
      throw new Error(`Target is occupied by ${existing.name}.`);
    }

    const faces = [
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1)
    ];

    const face = faces.find((candidate) => {
      const reference = bot.blockAt(targetPosition.minus(candidate));
      return reference && reference.boundingBox !== 'empty';
    });

    if (!face) throw new Error('No solid block beside that position to place against.');

    const referenceBlock = bot.blockAt(targetPosition.minus(face));

    await reply(username, `Placing ${item.name} at ${formatPosition(targetPosition)}.`);
    await runTask(`place ${item.name}`, reply, username, async () => {
      // Find a spot to stand that isn't the target position
      const standPos = targetPosition.offset(2, 0, 0); 
      await bot.pathfinder.goto(new GoalNear(standPos.x, standPos.y, standPos.z, 2));
      
      await bot.equip(item, 'hand');
      await bot.lookAt(targetPosition.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(referenceBlock, face);
    });
  }

  async function commandEquip(username, args, reply) {
    if (args.length < 1) throw new Error('Usage: equip item_name [hand|off-hand|head|torso|legs|feet]');

    const item = inventoryItem(args[0]);
    if (!item) throw new Error(`I do not have ${args[0]}.`);

    const destination = args[1] || 'hand';
    await bot.equip(item, destination);
    await reply(username, `Equipped ${item.name} to ${destination}.`);
  }

  async function commandInventory(username, reply) {
    const items = bot.inventory.items();
    if (items.length === 0) {
      await reply(username, 'Inventory is empty.');
      return;
    }

    const summary = items
      .slice(0, 12)
      .map((item) => `${item.name} x${item.count}`)
      .join(', ');
    const suffix = items.length > 12 ? `, plus ${items.length - 12} more stacks` : '';
    await reply(username, `${summary}${suffix}`);
  }

  async function commandDrop(username, args, reply) {
    if (args.length < 1) throw new Error('Usage: drop item_name [count|all]');

    const item = inventoryItem(args[0]);
    if (!item) throw new Error(`I do not have ${args[0]}.`);

    if (args[1] === 'all') {
      await bot.tossStack(item);
      await reply(username, `Dropped all ${item.name}.`);
      return;
    }

    const count = toCount(args[1], item.count, item.count);
    await bot.toss(item.type, null, count);
    await reply(username, `Dropped ${count} ${item.name}.`);
  }

  async function commandCraft(username, args, reply) {
    if (args.length < 1) throw new Error('Usage: craft item_name [count]');

    const itemType = itemByName(args[0]);
    if (!itemType) throw new Error(`Unknown item: ${args[0]}`);

    const requestedCount = toCount(args[1], 1, 256);
    const recipe = bot.recipesFor(itemType.id, null, 1, null)[0];
    if (!recipe) throw new Error(`I do not know a recipe for ${itemType.name} with my current inventory.`);

    const outputCount = recipe.result && recipe.result.count ? recipe.result.count : 1;
    const craftRuns = Math.ceil(requestedCount / outputCount);

    await reply(username, `Crafting at least ${requestedCount} ${itemType.name}.`);
    await runTask(`craft ${requestedCount} ${itemType.name}`, reply, username, async () => {
      let craftingTable = null;
      if (recipe.requiresTable) {
        craftingTable = bot.findBlock({
          matching: blockByName('crafting_table').id,
          maxDistance: 8
        });

        if (!craftingTable) {
          throw new Error('I need a crafting table for this recipe, but none are nearby.');
        }

        await bot.pathfinder.goto(new GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 3));
      }

      await bot.craft(recipe, craftRuns, craftingTable);
    });
  }

  async function commandSleep(username, reply) {
    const bed = bot.findBlock({
      matching: (block) => block && (block.name === 'bed' || block.name.endsWith('_bed')),
      maxDistance: 8
    });

    if (!bed) throw new Error('No bed nearby.');

    await bot.sleep(bed);
    await reply(username, 'Sleeping.');
  }

  async function commandWake(username, reply) {
    if (!bot.isSleeping) {
      await reply(username, 'I am already awake.');
      return;
    }

    await bot.wake();
    await reply(username, 'Awake.');
  }

  async function commandAttack(username, args, reply) {
    if (args.length < 1) throw new Error('Usage: attack mob_name_or_nearest');

    const target = nearestEntityByName(args[0]);
    if (!target) throw new Error(`No nearby ${args[0]} found.`);

    setActiveTask(`attack ${target.name || args[0]}`, stopPathing);
    bot.pathfinder.setGoal(new GoalFollow(target, 2), true);

    state.attackTimer = setInterval(() => {
      const stillThere = bot.entities[target.id];
      if (!stillThere) {
        clearActiveTask({ cancel: true });
        return;
      }

      const distance = bot.entity.position.distanceTo(stillThere.position);
      if (distance <= 3.5) {
        bot.lookAt(stillThere.position.offset(0, stillThere.height || 1, 0), true).catch(() => {});
        try {
          bot.attack(stillThere);
        } catch {
          clearActiveTask({ cancel: true });
        }
      }
    }, 700);

    await reply(username, `Attacking ${target.name || args[0]}. Use stop to cancel.`);
  }

  async function commandSay(username, args, reply) {
    if (args.length < 1) throw new Error('Usage: say message');
    bot.chat(args.join(' '));
    await reply(username, 'Said it.');
  }

  async function handle(username, commandName, args, reply) {
    ensureReady();

    switch (commandName) {
      case 'help':
      case '?':
        return commandHelp(username, reply);
      case 'status':
      case 'pos':
        return commandStatus(username, reply);
      case 'come':
        return commandCome(username, reply);
      case 'follow':
        return commandFollow(username, args, reply);
      case 'stop':
      case 'cancel':
        return commandStop(username, reply);
      case 'goto':
      case 'go':
        return commandGoto(username, args, reply);
      case 'mine':
      case 'dig':
      case 'collect':
        return commandMine(username, args, reply);
      case 'place':
      case 'build':
        return commandPlace(username, args, reply);
      case 'equip':
      case 'hold':
        return commandEquip(username, args, reply);
      case 'inventory':
      case 'inv':
        return commandInventory(username, reply);
      case 'drop':
      case 'toss':
        return commandDrop(username, args, reply);
      case 'craft':
        return commandCraft(username, args, reply);
      case 'sleep':
        return commandSleep(username, reply);
      case 'wake':
        return commandWake(username, reply);
      case 'attack':
      case 'hit':
        return commandAttack(username, args, reply);
      case 'say':
        return commandSay(username, args, reply);
      default:
        await reply(username, `Unknown command: ${commandName}. Try help.`);
        return undefined;
    }
  }

  return {
    handle,
    onSpawn
  };
}

module.exports = {
  createCommandRunner,
  parseArgs
};
