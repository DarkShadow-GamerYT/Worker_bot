'use strict';

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { GoalNear, GoalFollow } = goals;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAutonomyManager(bot, config) {
  const state = {
    active: config.autonomy.enabledByDefault,
    paused: false,
    currentAction: null,
    blacklist: new Set(),
    lastActionTime: 0,
    failedActionsCount: 0,
    placedTablePos: null
  };

  // Helper: check if we are in water, lava or fire
  function checkEnvironmentalDanger() {
    if (!bot.entity) return false;
    const blockAtFeet = bot.blockAt(bot.entity.position);
    const blockAtHead = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    
    const inLava = (blockAtFeet && blockAtFeet.name.includes('lava')) || (blockAtHead && blockAtHead.name.includes('lava'));
    const inFire = (blockAtFeet && blockAtFeet.name.includes('fire')) || (blockAtHead && blockAtHead.name.includes('fire'));
    
    if (inLava || inFire) {
      console.log('[Autonomy] Environmental Danger! In lava/fire. Trying to escape.');
      // Try to jump and move to a random direction
      bot.setControlState('jump', true);
      const yaw = Math.random() * Math.PI * 2;
      bot.look(yaw, 0, false);
      bot.setControlState('forward', true);
      setTimeout(() => {
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
      }, 1000);
      return true;
    }
    return false;
  }

  // Auto Eat
  async function performAutoEat() {
    if (!config.autonomy.autoEat) return false;
    if (bot.food >= 17) return false;

    const foods = [
      'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
      'golden_carrot', 'golden_apple', 'baked_potato', 'bread', 'carrot', 'apple', 'melon_slice', 'sweet_berries',
      'glow_berries', 'pumpkin_pie', 'cookie', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'
    ];

    const inventoryItems = bot.inventory.items();
    const foodItem = inventoryItems.find(item => foods.includes(item.name));
    
    if (foodItem) {
      console.log(`[Autonomy] Eating food: ${foodItem.name}`);
      const oldEquipped = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
      try {
        await bot.equip(foodItem, 'hand');
        await bot.consume();
        if (oldEquipped) {
          await bot.equip(oldEquipped, 'hand').catch(() => {});
        }
        return true;
      } catch (err) {
        console.error('[Autonomy] Failed to eat:', err.message);
      }
    }
    return false;
  }

  // Find nearest hostile mob
  function getNearestHostileMob() {
    const hostiles = [
      'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'slime', 'phantom',
      'drowned', 'husk', 'stray', 'cave_spider', 'zombified_piglin', 'piglin', 'hoglin',
      'wither_skeleton', 'blaze', 'ghast', 'magma_cube'
    ];
    
    return bot.nearestEntity((entity) => {
      if (!entity.position || !entity.isValid) return false;
      if (entity.type !== 'mob') return false;
      
      const entityName = (entity.name || '').toLowerCase();
      return hostiles.includes(entityName) || hostiles.some(h => entityName.includes(h));
    });
  }

  // Equip best weapon
  async function equipBestWeapon() {
    const items = bot.inventory.items();
    const weapons = ['sword', 'axe'];
    const tiers = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];

    const candidates = items.filter(i => weapons.some(w => i.name.includes(w)));
    if (candidates.length === 0) return;

    candidates.sort((a, b) => {
      const aTier = tiers.findIndex(t => a.name.includes(t));
      const bTier = tiers.findIndex(t => b.name.includes(t));
      if (aTier !== bTier) return (aTier === -1 ? 99 : aTier) - (bTier === -1 ? 99 : bTier);
      const aIsSword = a.name.includes('sword');
      const bIsSword = b.name.includes('sword');
      if (aIsSword !== bIsSword) return aIsSword ? -1 : 1;
      return 0;
    });

    const best = candidates[0];
    const inHand = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
    if (!inHand || inHand.name !== best.name || inHand.slot !== best.slot) {
      await bot.equip(best, 'hand').catch(() => {});
    }
  }

  // Equip best armor
  async function equipBestArmor() {
    const armorSlots = {
      helmet: 'head',
      chestplate: 'torso',
      leggings: 'legs',
      boots: 'feet'
    };
    
    const items = bot.inventory.items();
    const tiers = ['netherite', 'diamond', 'iron', 'golden', 'chainmail', 'leather'];

    for (const [nameMatch, slot] of Object.entries(armorSlots)) {
      const candidates = items.filter(i => i.name.includes(nameMatch));
      if (candidates.length === 0) continue;

      candidates.sort((a, b) => {
        const aTier = tiers.findIndex(t => a.name.includes(t));
        const bTier = tiers.findIndex(t => b.name.includes(t));
        return (aTier === -1 ? 99 : aTier) - (bTier === -1 ? 99 : bTier);
      });

      const best = candidates[0];
      const currentlyEquipped = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
      if (!currentlyEquipped || currentlyEquipped.name !== best.name) {
        await bot.equip(best, slot).catch(() => {});
      }
    }
  }

  // Auto Defend
  async function performAutoDefend() {
    if (!config.autonomy.autoDefend) return false;

    const target = getNearestHostileMob();
    if (!target || !bot.entity || !target.position) return false;

    const distance = bot.entity.position.distanceTo(target.position);
    // If a hostile mob is within 8 blocks, we engage defense mode
    if (distance <= 8.0) {
      console.log(`[Autonomy] Hostile mob detected: ${target.name} at ${distance.toFixed(1)} blocks. Defending.`);
      state.currentAction = `defending against ${target.name}`;
      
      await equipBestArmor();
      await equipBestWeapon();

      // If too far, pathfind to target
      if (distance > 3.0) {
        bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
      } else {
        // Stop moving and hit
        if (bot.pathfinder.isMoving()) {
          bot.pathfinder.setGoal(null);
        }
        await bot.lookAt(target.position.offset(0, target.height || 1, 0), true).catch(() => {});
        try {
          bot.attack(target);
        } catch (e) {}
      }
      return true;
    }
    return false;
  }

  // Auto Sleep
  async function performAutoSleep() {
    if (!config.autonomy.autoSleep) return false;
    
    // Check if it is night time (13000 to 23000 ticks)
    const time = bot.time.timeOfDay;
    if (time < 13000 || time > 23000) return false;

    // Already sleeping?
    if (bot.isSleeping) return true;

    console.log('[Autonomy] It is night. Searching for a bed.');
    state.currentAction = 'searching for bed to sleep';

    const bed = bot.findBlock({
      matching: (block) => block && (block.name === 'bed' || block.name.endsWith('_bed')),
      maxDistance: 16
    });

    if (bed) {
      const distance = bot.entity.position.distanceTo(bed.position);
      if (distance > 3) {
        try {
          await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
        } catch (e) {
          console.log('[Autonomy] Failed to pathfind to bed:', e.message);
          return false;
        }
      }
      try {
        await bot.sleep(bed);
        console.log('[Autonomy] Going to sleep.');
        return true;
      } catch (err) {
        console.log('[Autonomy] Bed is occupied or sleep failed:', err.message);
      }
    } else {
      // Check if we have a bed in inventory to place
      const bedItem = bot.inventory.items().find(i => i.name.endsWith('_bed'));
      if (bedItem) {
        console.log('[Autonomy] Found bed in inventory. Placing it to sleep.');
        // Try placing bed on a flat solid block
        const reference = bot.findBlock({
          matching: (block) => block && block.boundingBox === 'block' && block.name !== 'air',
          maxDistance: 4
        });
        if (reference) {
          try {
            await bot.equip(bedItem, 'hand');
            await bot.placeBlock(reference, new Vec3(0, 1, 0));
            return true;
          } catch (e) {
            console.log('[Autonomy] Failed to place bed:', e.message);
          }
        }
      }
    }
    return false;
  }

  // Check inventory helper
  function hasItem(nameMatch) {
    return bot.inventory.items().some(i => i.name.includes(nameMatch));
  }

  function getItemCount(nameMatch) {
    return bot.inventory.items()
      .filter(i => i.name.includes(nameMatch))
      .reduce((sum, i) => sum + i.count, 0);
  }

  // Choose the best tool for the specific block being mined, considering efficiency enchants
  async function equipBestTool(block) {
    if (!block) return;
    const items = bot.inventory.items();
    let toolType = 'pickaxe';
    if (block.name.includes('wood') || block.name.includes('log') || block.name.includes('stem') || block.name === 'crafting_table' || block.name.includes('chest')) {
      toolType = 'axe';
    } else if (block.name.includes('dirt') || block.name.includes('grass') || block.name.includes('sand') || block.name.includes('gravel') || block.name.includes('clay')) {
      toolType = 'shovel';
    }
    
    const candidates = items.filter(i => i.name.includes(toolType));
    if (candidates.length === 0) return;

    const tiers = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
    candidates.sort((a, b) => {
      const aTier = tiers.findIndex(t => a.name.includes(t));
      const bTier = tiers.findIndex(t => b.name.includes(t));
      if (aTier !== bTier) return (aTier === -1 ? 99 : aTier) - (bTier === -1 ? 99 : bTier);
      
      const getEnchLevel = (item) => {
        if (item.enchantments) {
          const eff = item.enchantments.find(e => e.name === 'efficiency');
          if (eff) return eff.lvl + 10;
          return item.enchantments.length > 0 ? 1 : 0;
        }
        if (!item.nbt || !item.nbt.value) return 0;
        const val = item.nbt.value;
        const str = JSON.stringify(val).toLowerCase();
        if (str.includes('efficiency')) {
          const match = str.match(/\"lvl\"\s*:\s*(\d+)/) || str.match(/\"id\"\s*:\s*\"minecraft:efficiency\"\s*,\s*\"lvl\"\s*:\s*(\d+)/);
          if (match) return parseInt(match[1], 10) + 10;
          return 11;
        }
        if (val.ench || val.Enchantments || (val.components && val.components.value)) {
          return 1;
        }
        return 0;
      };

      return getEnchLevel(b) - getEnchLevel(a);
    });

    const best = candidates[0];
    const inHand = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
    if (!inHand || inHand.name !== best.name || inHand.slot !== best.slot) {
      await bot.equip(best, 'hand').catch(() => {});
    }
  }

  // Survival loop behavior: Gather resources and progress tools
  async function performSurvivalProgression() {
    const logTypes = ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'mangrove_log', 'cherry_log', 'log'];
    const planksTypes = ['oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks', 'acacia_planks', 'jungle_planks', 'mangrove_planks', 'cherry_planks', 'planks'];

    // 1. Gather wood if we have no logs and no planks and no wooden tools
    const logCount = bot.inventory.items().filter(i => logTypes.some(type => i.name.includes(type))).reduce((sum, i) => sum + i.count, 0);
    const planksCount = bot.inventory.items().filter(i => planksTypes.some(type => i.name.includes(type))).reduce((sum, i) => sum + i.count, 0);
    const hasPickaxe = hasItem('pickaxe');
    const hasSword = hasItem('sword');

    // Progression Logic:
    // A. If we don't have a pickaxe, we need wood
    if (!hasPickaxe) {
      if (logCount < 4 && planksCount < 12) {
        console.log('[Autonomy] Goal: Gather wood. Searching for logs.');
        state.currentAction = 'gathering wood logs';
        
        const logBlock = bot.findBlock({
          matching: (block) => logTypes.some(type => block.name === type || block.name.includes('log')),
          maxDistance: 32
        });

        if (logBlock) {
          if (state.blacklist.has(logBlock.position.toString())) {
            // Find another one
            return false;
          }
          console.log(`[Autonomy] Mining log at ${logBlock.position}`);
          try {
            await equipBestTool(logBlock).catch(() => {});
            await bot.collectBlock.collect(logBlock);
            state.failedActionsCount = 0;
            return true;
          } catch (err) {
            console.log('[Autonomy] Failed to collect log:', err.message);
            state.blacklist.add(logBlock.position.toString());
            state.failedActionsCount++;
            return false;
          }
        } else {
          console.log('[Autonomy] No wood logs found nearby.');
          return false;
        }
      }

      // If we have logs, craft them into planks
      if (logCount >= 4 && planksCount < 12) {
        console.log('[Autonomy] Goal: Craft logs to planks.');
        state.currentAction = 'crafting planks';
        
        const logItem = bot.inventory.items().find(i => logTypes.some(type => i.name.includes(type)));
        if (logItem) {
          const recipeName = logItem.name.replace('_log', '_planks').replace('log', 'planks');
          const planksRecipe = bot.recipesFor(bot.registry.itemsByName[recipeName]?.id, null, 1, null)[0];
          if (planksRecipe) {
            try {
              await bot.craft(planksRecipe, 4, null);
              console.log('[Autonomy] Crafted planks.');
              return true;
            } catch (err) {
              console.log('[Autonomy] Craft planks failed:', err.message);
            }
          }
        }
      }

      // If we have planks but no crafting table, craft crafting table
      const hasTableInInv = hasItem('crafting_table');
      const tableBlockNear = bot.findBlock({
        matching: (block) => block.name === 'crafting_table',
        maxDistance: 8
      });

      if (planksCount >= 4 && !hasTableInInv && !tableBlockNear) {
        console.log('[Autonomy] Goal: Craft crafting table.');
        state.currentAction = 'crafting crafting table';
        
        const tableRecipe = bot.recipesFor(bot.registry.itemsByName['crafting_table']?.id, null, 1, null)[0];
        if (tableRecipe) {
          try {
            await bot.craft(tableRecipe, 1, null);
            console.log('[Autonomy] Crafted crafting table.');
            return true;
          } catch (err) {
            console.log('[Autonomy] Craft table failed:', err.message);
          }
        }
      }

      // Craft sticks if we need them (we need at least 4 sticks)
      const stickCount = getItemCount('stick');
      if (planksCount >= 2 && stickCount < 4) {
        console.log('[Autonomy] Goal: Craft sticks.');
        state.currentAction = 'crafting sticks';
        const stickRecipe = bot.recipesFor(bot.registry.itemsByName['stick']?.id, null, 1, null)[0];
        if (stickRecipe) {
          try {
            await bot.craft(stickRecipe, 1, null);
            console.log('[Autonomy] Crafted sticks.');
            return true;
          } catch (err) {
            console.log('[Autonomy] Craft sticks failed:', err.message);
          }
        }
      }

      // Place crafting table and craft a wooden pickaxe
      if (hasTableInInv && stickCount >= 2 && planksCount >= 3) {
        console.log('[Autonomy] Goal: Place table & craft wooden pickaxe.');
        state.currentAction = 'placing table and crafting wooden pickaxe';

        let table = tableBlockNear;
        if (!table) {
          // Place it
          const reference = bot.findBlock({
            matching: (block) => block && block.boundingBox === 'block' && block.name !== 'air' && block.name !== 'crafting_table',
            maxDistance: 4
          });
          if (reference) {
            try {
              const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
              await bot.equip(tableItem, 'hand');
              await bot.placeBlock(reference, new Vec3(0, 1, 0));
              console.log('[Autonomy] Placed crafting table.');
              await sleep(500);
              table = bot.findBlock({
                matching: (block) => block.name === 'crafting_table',
                maxDistance: 8
              });
            } catch (err) {
              console.log('[Autonomy] Failed to place table:', err.message);
            }
          }
        }

        if (table) {
          const pickaxeRecipe = bot.recipesFor(bot.registry.itemsByName['wooden_pickaxe']?.id, null, 1, table)[0];
          if (pickaxeRecipe) {
            try {
              await bot.craft(pickaxeRecipe, 1, table);
              console.log('[Autonomy] Crafted wooden pickaxe!');
              return true;
            } catch (err) {
              console.log('[Autonomy] Craft wooden pickaxe failed:', err.message);
            }
          }
        }
      }
    }

    // B. Upgrade to stone pickaxe/sword if we have a pickaxe but no stone tools
    const hasStonePickaxe = hasItem('stone_pickaxe');
    const hasStoneSword = hasItem('stone_sword');
    const stoneCount = getItemCount('cobblestone') + getItemCount('stone');

    if (hasPickaxe && (!hasStonePickaxe || !hasStoneSword)) {
      if (stoneCount < 10) {
        console.log('[Autonomy] Goal: Mine cobblestone/stone.');
        state.currentAction = 'mining stone/cobblestone';
        
        const stoneBlock = bot.findBlock({
          matching: (block) => ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate'].includes(block.name),
          maxDistance: 32
        });

        if (stoneBlock) {
          if (state.blacklist.has(stoneBlock.position.toString())) return false;
          console.log(`[Autonomy] Mining stone at ${stoneBlock.position}`);
          try {
            await equipBestTool(stoneBlock).catch(() => {});
            await bot.collectBlock.collect(stoneBlock);
            state.failedActionsCount = 0;
            return true;
          } catch (err) {
            console.log('[Autonomy] Failed to collect stone:', err.message);
            state.blacklist.add(stoneBlock.position.toString());
            state.failedActionsCount++;
            return false;
          }
        } else {
          console.log('[Autonomy] No stone found nearby.');
          return false;
        }
      }

      // Craft stone pickaxe or sword
      const tableBlockNear = bot.findBlock({
        matching: (block) => block.name === 'crafting_table',
        maxDistance: 8
      });

      if (stoneCount >= 3 && !hasStonePickaxe) {
        console.log('[Autonomy] Goal: Craft stone pickaxe.');
        state.currentAction = 'crafting stone pickaxe';
        
        let table = tableBlockNear;
        if (!table && hasItem('crafting_table')) {
          const reference = bot.findBlock({
            matching: (block) => block && block.boundingBox === 'block' && block.name !== 'air' && block.name !== 'crafting_table',
            maxDistance: 4
          });
          if (reference) {
            try {
              const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
              await bot.equip(tableItem, 'hand');
              await bot.placeBlock(reference, new Vec3(0, 1, 0));
              await sleep(500);
              table = bot.findBlock({
                matching: (block) => block.name === 'crafting_table',
                maxDistance: 8
              });
            } catch (e) {}
          }
        }

        if (table) {
          const stickCount = getItemCount('stick');
          if (stickCount < 2) {
            // Need sticks
            const stickRecipe = bot.recipesFor(bot.registry.itemsByName['stick']?.id, null, 1, table)[0];
            if (stickRecipe) {
              await bot.craft(stickRecipe, 1, table).catch(() => {});
            }
          }
          const stonePickaxeRecipe = bot.recipesFor(bot.registry.itemsByName['stone_pickaxe']?.id, null, 1, table)[0];
          if (stonePickaxeRecipe) {
            try {
              await bot.craft(stonePickaxeRecipe, 1, table);
              console.log('[Autonomy] Crafted stone pickaxe!');
              return true;
            } catch (err) {
              console.log('[Autonomy] Craft stone pickaxe failed:', err.message);
            }
          }
        }
      }

      if (stoneCount >= 2 && !hasStoneSword) {
        console.log('[Autonomy] Goal: Craft stone sword.');
        state.currentAction = 'crafting stone sword';

        let table = tableBlockNear;
        if (table) {
          const stickCount = getItemCount('stick');
          if (stickCount < 1) {
            const stickRecipe = bot.recipesFor(bot.registry.itemsByName['stick']?.id, null, 1, table)[0];
            if (stickRecipe) {
              await bot.craft(stickRecipe, 1, table).catch(() => {});
            }
          }
          const stoneSwordRecipe = bot.recipesFor(bot.registry.itemsByName['stone_sword']?.id, null, 1, table)[0];
          if (stoneSwordRecipe) {
            try {
              await bot.craft(stoneSwordRecipe, 1, table);
              console.log('[Autonomy] Crafted stone sword!');
              return true;
            } catch (err) {
              console.log('[Autonomy] Craft stone sword failed:', err.message);
            }
          }
        }
      }
    }

    // C. Hunt passive mobs for food if we are low on food in inventory
    const foodItems = bot.inventory.items().filter(item => {
      const foods = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];
      return foods.includes(item.name);
    });
    const totalFoodCount = foodItems.reduce((sum, i) => sum + i.count, 0);

    if (totalFoodCount < 3) {
      console.log('[Autonomy] Goal: Hunt passive animals for food.');
      state.currentAction = 'hunting passive animals for food';

      const prey = bot.nearestEntity((entity) => {
        if (!entity.position || !entity.isValid) return false;
        if (entity.type !== 'mob') return false;
        return ['cow', 'sheep', 'pig', 'chicken', 'rabbit'].includes((entity.name || '').toLowerCase());
      });

      if (prey) {
        const distance = bot.entity.position.distanceTo(prey.position);
        if (distance > 3) {
          bot.pathfinder.setGoal(new GoalFollow(prey, 2), true);
        } else {
          await equipBestWeapon();
          await bot.lookAt(prey.position.offset(0, prey.height || 1, 0), true).catch(() => {});
          try {
            bot.attack(prey);
          } catch (e) {}
        }
        return true;
      }
    }

    // D. Mine valuable ores (coal, iron) if we spot them nearby
    if (hasStonePickaxe) {
      const oreTypes = ['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore'];
      const oreBlock = bot.findBlock({
        matching: (block) => oreTypes.includes(block.name),
        maxDistance: 16
      });

      if (oreBlock && !state.blacklist.has(oreBlock.position.toString())) {
        console.log(`[Autonomy] Goal: Mining valuable ore: ${oreBlock.name}`);
        state.currentAction = `mining ${oreBlock.name}`;
        try {
          await equipBestTool(oreBlock).catch(() => {});
          await bot.collectBlock.collect(oreBlock);
          state.failedActionsCount = 0;
          return true;
        } catch (err) {
          console.log(`[Autonomy] Failed to mine ore ${oreBlock.name}:`, err.message);
          state.blacklist.add(oreBlock.position.toString());
          state.failedActionsCount++;
          return false;
        }
      }
    }

    return false;
  }

  // Wander randomly or pick up items on the ground
  async function performWanderingAndLooting() {
    console.log('[Autonomy] Goal: Exploring and looting.');
    
    // Check if there is an item drop on the ground nearby (within 16 blocks)
    const itemEntity = bot.nearestEntity((entity) => {
      if (!entity.position || !entity.isValid) return false;
      // Item entities or experience orbs
      return ['item', 'experience_orb'].includes(entity.name) || entity.type === 'object';
    });

    if (itemEntity) {
      const distance = bot.entity.position.distanceTo(itemEntity.position);
      if (distance <= 16.0) {
        console.log(`[Autonomy] Pathing to collect item drop: ${itemEntity.name || 'item'} at ${itemEntity.position}`);
        state.currentAction = 'picking up nearby item drop';
        try {
          bot.pathfinder.setGoal(new GoalNear(itemEntity.position.x, itemEntity.position.y, itemEntity.position.z, 1));
          return true;
        } catch (e) {
          console.log('[Autonomy] Pathing to item failed:', e.message);
        }
      }
    }

    // Otherwise, do a small random wander to look around
    state.currentAction = 'wandering';
    const currentPos = bot.entity.position;
    const rx = currentPos.x + (Math.random() - 0.5) * 16;
    const rz = currentPos.z + (Math.random() - 0.5) * 16;
    const ry = currentPos.y; // Assume similar height

    try {
      console.log(`[Autonomy] Wandering to random position: ${Math.floor(rx)} ${Math.floor(ry)} ${Math.floor(rz)}`);
      bot.pathfinder.setGoal(new GoalNear(rx, ry, rz, 2));
      return true;
    } catch (err) {
      console.log('[Autonomy] Wandering pathfind failed:', err.message);
    }
    return false;
  }

  // Main tick evaluation loop
  async function tick() {
    if (!state.active || state.paused) {
      // Even when autonomy is off/paused, auto-defend and auto-eat can run if configured
      if (!state.paused) {
        if (await performAutoEat()) return;
        if (await performAutoDefend()) return;
      }
      return;
    }

    if (!bot.entity || !bot.pathfinder) return;

    // Check last action time to prevent spamming actions
    const now = Date.now();
    if (now - state.lastActionTime < 3000) return;

    // Ensure we are pathfinding or collectBlock is not currently executing a precise subtask
    if (bot.pathfinder.isMoving()) {
      // Allow current movement goal to progress
      return;
    }

    // 1. Environmental Danger Check
    if (checkEnvironmentalDanger()) {
      state.lastActionTime = now;
      return;
    }

    // 2. Auto Defense (Priority 1)
    if (await performAutoDefend()) {
      state.lastActionTime = now;
      return;
    }

    // 3. Auto Eat (Priority 2)
    if (await performAutoEat()) {
      state.lastActionTime = now;
      return;
    }

    // 4. Auto Sleep (Priority 3)
    if (await performAutoSleep()) {
      state.lastActionTime = now;
      return;
    }

    // 5. Survival Progression (Priority 4)
    if (await performSurvivalProgression()) {
      state.lastActionTime = now;
      return;
    }

    // 6. Wander and Loot (Priority 5)
    if (await performWanderingAndLooting()) {
      state.lastActionTime = now;
      return;
    }
  }

  // Periodically clear blacklist so bot can retry blocks later
  const blacklistInterval = setInterval(() => {
    state.blacklist.clear();
  }, 120000); // 2 minutes

  bot.once('end', () => {
    clearInterval(blacklistInterval);
  });

  return {
    isActive() { return state.active; },
    isPaused() { return state.paused; },
    getCurrentAction() { return state.currentAction || 'idle'; },
    
    start() {
      state.active = true;
      state.paused = false;
      state.currentAction = 'starting';
      console.log('[Autonomy] Autonomy mode started.');
    },
    
    stop() {
      state.active = false;
      state.paused = false;
      state.currentAction = 'stopped';
      if (bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }
      console.log('[Autonomy] Autonomy mode stopped.');
    },
    
    pause() {
      state.paused = true;
      if (bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }
      console.log('[Autonomy] Autonomy mode paused.');
    },
    
    resume() {
      state.paused = false;
      console.log('[Autonomy] Autonomy mode resumed.');
    },
    
    tick
  };
}

module.exports = {
  createAutonomyManager
};
